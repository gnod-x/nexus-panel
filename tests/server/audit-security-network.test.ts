import { afterEach, describe, expect, it, vi } from 'vitest';
import dns from 'node:dns/promises';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { once } from 'node:events';
import * as security from '../../src/server/security.js';
import { probeHealth } from '../../src/server/health.js';
import { fetchIntegrationJson } from '../../src/server/integrations.js';

const oldAllowed = process.env.HEALTH_ALLOWED_CIDRS;
const oldTimeout = process.env.HEALTH_TIMEOUT_MS;
const servers: http.Server[] = [];
async function local(handler: http.RequestListener) {
  const app = http.createServer(handler); servers.push(app); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const url = 'http://network-audit.invalid:' + (app.address() as AddressInfo).port;
  const resolve = async (target: string) => ({ url: new URL(target), address: '127.0.0.1' });
  return { app, url, resolve };
}
afterEach(async () => {
  vi.restoreAllMocks();
  if (oldAllowed === undefined) delete process.env.HEALTH_ALLOWED_CIDRS; else process.env.HEALTH_ALLOWED_CIDRS = oldAllowed;
  if (oldTimeout === undefined) delete process.env.HEALTH_TIMEOUT_MS; else process.env.HEALTH_TIMEOUT_MS = oldTimeout;
  for (const app of servers.splice(0)) { app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); }
});
const answer = (address: string) => ({ address, family: address.includes(':') ? 6 : 4 });

describe('audit SSRF validates every DNS answer, not merely the selected one', () => {
  it.each([
    ['public then loopback', ['1.1.1.1','127.0.0.1']],
    ['loopback then public', ['127.0.0.1','1.1.1.1']],
    ['public plus metadata', ['1.1.1.1','169.254.169.254']],
    ['public plus unauthorized private', ['1.1.1.1','10.201.1.2']],
    ['public plus IPv6 loopback', ['1.1.1.1','::1']],
    ['public plus mapped metadata', ['1.1.1.1','::ffff:169.254.169.254']],
    ['public plus translated metadata', ['1.1.1.1','64:ff9b::a9fe:a9fe']],
    ['public plus documentation address', ['1.1.1.1','203.0.113.8']],
  ])('rejects %s without making outbound HTTP', async (_name, addresses) => {
    delete process.env.HEALTH_ALLOWED_CIDRS;
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue(addresses.map(answer) as never);
    const request = vi.spyOn(http, 'request');
    await expect(security.resolveTarget('http://multi-answer.audit.invalid/health')).rejects.toThrow();
    expect(lookup).toHaveBeenCalledTimes(1); expect(request).not.toHaveBeenCalled();
  });
  it('rejects an empty DNS answer set and resolver errors', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue([] as never);
    await expect(security.resolveTarget('https://empty.audit.invalid')).rejects.toThrow();
    lookup.mockRejectedValue(new Error('synthetic resolver failure'));
    await expect(security.validateTargetUrl('https://failed.audit.invalid')).rejects.toThrow();
  });
  it('checks all answers against a narrow private network allowlist', async () => {
    process.env.HEALTH_ALLOWED_CIDRS = '10.201.1.0/24';
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue(['10.201.1.2','10.201.1.3'].map(answer) as never);
    expect((await security.resolveTarget('http://private.audit.invalid')).address).toBe('10.201.1.2');
    lookup.mockResolvedValue(['10.201.1.2','10.201.2.3'].map(answer) as never);
    await expect(security.resolveTarget('http://private.audit.invalid')).rejects.toThrow();
  });
  it('selects exactly the first allowed validated address after one lookup', async () => {
    delete process.env.HEALTH_ALLOWED_CIDRS;
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue(['1.1.1.1','2606:4700:4700::1111'].map(answer) as never);
    const result = await security.resolveTarget('https://pinned.audit.invalid/check');
    expect(result.address).toBe('1.1.1.1'); expect(result.url.hostname).toBe('pinned.audit.invalid');
    expect(lookup).toHaveBeenCalledTimes(1);
  });
  it.each([
    'http://2130706433','http://0x7f000001','http://0177.0.0.1','http://127.1','http://127.000.000.001',
    'http://169.254.4.5','http://0.0.0.0','http://224.0.0.1','http://255.255.255.255','http://192.0.2.4',
    'http://198.51.100.5','http://203.0.113.6','http://[::1]','http://[::]','http://[fe80::1]',
    'http://[ff02::1]','http://[2001:db8::1]','http://[::ffff:7f00:1]','http://[64:ff9b::7f00:1]',
    'http://[64:ff9b:1::7f00:1]','http://[fd00:ec2::1234]',
  ])('cannot allowlist hard-blocked special destination %s', async target => {
    process.env.HEALTH_ALLOWED_CIDRS = '0.0.0.0/0,::/0';
    await expect(security.resolveTarget(target)).rejects.toThrow();
  });
  it.each(['metadata.google.internal','metadata.google.internal.','METADATA.GOOGLE.INTERNAL','metadata.google.com','instance-data.ec2.internal','metadata.azure.internal'])('blocks metadata hostname %s before DNS', async host => {
    const lookup = vi.spyOn(dns, 'lookup');
    await expect(security.resolveTarget('http://' + host)).rejects.toThrow();
    expect(lookup).not.toHaveBeenCalled();
  });
  it('does not treat a metadata hostname lookalike as a reason to skip actual DNS policy', async () => {
    const lookup = vi.spyOn(dns, 'lookup').mockResolvedValue([answer('127.0.0.1')] as never);
    await expect(security.resolveTarget('https://metadata.google.internal.attacker.audit.invalid')).rejects.toThrow();
    expect(lookup).toHaveBeenCalledTimes(1);
  });
});

describe('audit isolated health request behavior', () => {
  it('health probe pins socket address, retains Host, does not follow redirect and discards body', async () => {
    const seen: string[] = [];
    const fixture = await local((request, response) => {
      seen.push(request.method + ' ' + request.url + ' ' + request.headers.host);
      response.writeHead(302, { location: '/must-not-follow' }); response.end('synthetic private body');
    });
    const resolver = vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
    const status = await probeHealth(fixture.url + '/health?synthetic=1');
    expect(status).toBe(302); expect(resolver).toHaveBeenCalledTimes(1);
    expect(seen).toEqual(['GET /health?synthetic=1 ' + new URL(fixture.url).host]);
  });
  it('health completion waits only for headers, not an unbounded streaming body', async () => {
    const fixture = await local((_request, response) => { response.writeHead(204); response.flushHeaders(); });
    vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
    expect(await probeHealth(fixture.url)).toBe(204);
  });
  it('health DNS timeout prevents a late resolution from making a new connection', async () => {
    process.env.HEALTH_TIMEOUT_MS = '500';
    let release: ((value: { url: URL; address: string }) => void) | undefined;
    let calls = 0;
    const fixture = await local((_request, response) => { calls++; response.end(); });
    vi.spyOn(security, 'resolveTarget').mockImplementation(() => new Promise(resolve => { release = resolve; }));
    await expect(probeHealth(fixture.url)).rejects.toThrow('deadline');
    release!({ url: new URL(fixture.url), address: '127.0.0.1' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(calls).toBe(0);
  });
});

describe('audit integration deadline completion and hostile payload boundaries', () => {
  it('an integration DNS result arriving after deadline cannot trigger an authenticated request', async () => {
    let release: ((value: { url: URL; address: string }) => void) | undefined;
    let calls = 0;
    const fixture = await local((_request, response) => { calls++; response.setHeader('content-type', 'application/json'); response.end('{}'); });
    const promise = fetchIntegrationJson(fixture.url + '/stats', 'synthetic-private-marker', {
      timeoutMs: 35, resolve: () => new Promise(resolve => { release = resolve; }),
    });
    await expect(promise).rejects.toMatchObject({ code: 'timeout' });
    release!({ url: new URL(fixture.url), address: '127.0.0.1' });
    await new Promise<void>(resolve => setImmediate(resolve));
    expect(calls).toBe(0);
  });
  it('supports safe +json content types without expanding fields itself', async () => {
    const fixture = await local((_request, response) => { response.setHeader('content-type', 'application/problem+json; charset=utf-8'); response.end('{"kind":"synthetic"}'); });
    expect(await fetchIntegrationJson(fixture.url, undefined, { resolve: fixture.resolve })).toEqual({ kind: 'synthetic' });
  });
  it('maps connection termination during a partial body to a controlled error', async () => {
    const fixture = await local((_request, response) => {
      response.writeHead(200, { 'content-type': 'application/json', 'content-length': '200' });
      response.write('{"partial":');
      setImmediate(() => response.destroy());
    });
    await expect(fetchIntegrationJson(fixture.url, undefined, { resolve: fixture.resolve, timeoutMs: 300 })).rejects.toMatchObject({ code: 'unavailable' });
  });
  it('the 512KiB limit includes UTF-8 bytes, not JavaScript character count', async () => {
    const fixture = await local((_request, response) => {
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ text: '文'.repeat(180000) }));
    });
    await expect(fetchIntegrationJson(fixture.url, undefined, { resolve: fixture.resolve })).rejects.toMatchObject({ code: 'response_too_large' });
  });
  it('serialized JSON primitive values are transport data, never implicit safe integration counters', async () => {
    for (const body of ['null','true','12','"synthetic"']) {
      const fixture = await local((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(body); });
      const value = await fetchIntegrationJson(fixture.url, undefined, { resolve: fixture.resolve });
      expect(value).toEqual(JSON.parse(body));
    }
  });
});

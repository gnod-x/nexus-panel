import { afterEach, describe, expect, it, vi } from 'vitest';
import Fastify from 'fastify';
import fs from 'node:fs';
import { mkdtemp, writeFile, rm, symlink, utimes } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import http from 'node:http';
import https from 'node:https';
import { EventEmitter } from 'node:events';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import * as security from '../../src/server/security.js';
import { fetchIntegrationJson, readIntegrationSnapshot, registerIntegrationRoutes, summarizeIntegration } from '../../src/server/integrations.js';

const folders: string[] = [];
const servers: http.Server[] = [];
let sequence = 0;
const now = Date.parse('2026-02-05T12:00:00Z');
const speed = (changes: Record<string, unknown> = {}) => ({
  total_scanned: 23, total_verified: 7, jp_recommendations: [{ url: 'synthetic-secret-marker' }], us_recommendations: [{ token: 'synthetic-secret-marker' }, {}],
  scanning: false, updated_at: '2026-02-05T11:00:00Z', ...changes,
});
const vod = { done: 12, pending: 2, searching: 3, found: 1, saving: 4, failed: 1, plays: 44 };
async function config(value: unknown) {
  const root = await mkdtemp(path.join(tmpdir(), 'nexus-integration-fixture-')); folders.push(root);
  const filename = path.join(root, 'config.json'); await writeFile(filename, JSON.stringify(value));
  return filename;
}
function item(baseUrl: string, changes: Record<string, unknown> = {}) {
  return { id: 'fixture-' + ++sequence, name: 'Synthetic source', kind: 'cfspeed', baseUrl, ...changes };
}
async function server(handler: http.RequestListener) {
  const app = http.createServer(handler); servers.push(app); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const port = (app.address() as AddressInfo).port;
  const url = 'http://synthetic-adapter.test:' + port;
  const resolve = async (target: string) => ({ url: new URL(target), address: '127.0.0.1' });
  return { app, url, resolve };
}
afterEach(async () => {
  vi.restoreAllMocks();
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
  for (const folder of folders.splice(0)) await rm(folder, { recursive: true, force: true });
});

describe('integration configuration and safe summaries', () => {
  it('missing configuration remains unconfigured without invented observations or metrics', async () => {
    const snapshot = await readIntegrationSnapshot({ configPath: '/nonexistent-synthetic-integration.json', demoMode: false, now: () => now });
    expect(snapshot.mode).toBe('unconfigured'); expect(snapshot.connections).toHaveLength(2);
    for (const connection of snapshot.connections) {
      expect(connection.status).toBe('unconfigured'); expect(connection.metrics).toEqual([]);
      expect(connection.observedAt).toBeNull(); expect(connection.sourceUpdatedAt).toBeNull();
      expect(connection.freshness).toBe('unknown');
    }
  });
  it('only explicit demo produces synthetic example metrics', async () => {
    const snapshot = await readIntegrationSnapshot({ configPath: '/missing', demoMode: true, now: () => now });
    expect(snapshot.mode).toBe('demo');
    expect(snapshot.connections.every(connection => connection.status === 'demo')).toBe(true);
    expect(snapshot.connections.every(connection => connection.metrics.length > 0)).toBe(true);
  });
  it('strictly rejects unknown keys, credentials, non-http URL, duplicate IDs and unsafe token paths', async () => {
    const entry = item('http://synthetic.invalid');
    const values = [
      { version: 1, connections: [], command: 'synthetic-marker' },
      { version: 2, connections: [] },
      { version: 1, connections: [{ ...entry, token: 'synthetic-marker' }] },
      { version: 1, connections: [{ ...entry, baseUrl: 'http://user:synthetic-marker@synthetic.invalid' }] },
      { version: 1, connections: [{ ...entry, baseUrl: 'file:///etc/passwd' }] },
      { version: 1, connections: [{ ...entry, baseUrl: 'http://synthetic.invalid?token=synthetic-marker' }] },
      { version: 1, connections: [{ ...entry, baseUrl: 'http://synthetic.invalid#synthetic-marker' }] },
      { version: 1, connections: [{ ...entry, name: 'https://synthetic-marker.invalid' }] },
      { version: 1, connections: [entry, entry] },
      { version: 1, connections: [{ ...entry, kind: 'quark-vod', tokenFile: '/tmp/synthetic-marker' }] },
      { version: 1, connections: [{ ...entry, kind: 'quark-vod' }] },
      { version: 1, connections: [{ ...entry, tokenFile: '/run/secrets/synthetic-marker' }] },
    ];
    for (const value of values) {
      const snapshot = await readIntegrationSnapshot({ configPath: await config(value), demoMode: false, now: () => now });
      expect(snapshot.mode).toBe('live');
      expect(snapshot.connections.every(connection => connection.errorCode === 'config_invalid')).toBe(true);
      expect(JSON.stringify(snapshot)).not.toContain('synthetic-marker');
      expect(snapshot.connections.every(connection => connection.metrics.length === 0)).toBe(true);
    }
  });
  it('refuses symlink config and oversized/invalid JSON without leaking input', async () => {
    const filename = await config({ version: 1, connections: [] });
    const link = filename + '.link'; await symlink(filename, link);
    for (const target of [link, filename]) {
      if (target === filename) await writeFile(filename, 'x'.repeat(65537));
      const result = await readIntegrationSnapshot({ configPath: target, demoMode: false, now: () => now });
      expect(result.connections.every(connection => connection.status === 'error')).toBe(true);
      expect(JSON.stringify(result)).not.toContain(filename);
    }
    await writeFile(filename, '{"private":"synthetic-marker"');
    const invalid = await readIntegrationSnapshot({ configPath: filename, demoMode: false, now: () => now });
    expect(invalid.connections.every(connection => connection.errorCode === 'config_invalid')).toBe(true);
    expect(JSON.stringify(invalid)).not.toContain('synthetic-marker');
  });
  it('summaries expose allowlisted numbers and scanning enum only, never remote fields', () => {
    const summary = summarizeIntegration('cfspeed', speed({ source_ip: 'synthetic-secret-marker', logs: 'synthetic-secret-marker' }));
    expect(summary.metrics.map(metric => metric.value)).toEqual([23, 7, 1, 2, '空闲']);
    expect(JSON.stringify(summary)).not.toContain('synthetic-secret-marker');
    const result = summarizeIntegration('quark-vod', { ...vod, cookie: 'synthetic-secret-marker', names: ['synthetic-secret-marker'] });
    expect(result.metrics.map(metric => metric.value)).toEqual([12, 10, 1, 44]);
    expect(JSON.stringify(result)).not.toContain('synthetic-secret-marker');
    for (const change of [{ total_scanned: -1 }, { total_verified: 1.5 }, { scanning: 'false' }, { total_scanned: Number.POSITIVE_INFINITY }]) {
      expect(() => summarizeIntegration('cfspeed', speed(change))).toThrow();
    }
    expect(() => summarizeIntegration('quark-vod', { ...vod, pending: Number.MAX_SAFE_INTEGER, saving: 2 })).toThrow();
  });
  it('rejects invalid calendar timestamps instead of normalizing nonexistent dates', () => {
    for (const updated_at of ['2026-02-30T12:00:00Z', '2026-04-31T12:00:00Z', '2026-02-05T25:00:00Z']) {
      expect(summarizeIntegration('cfspeed', speed({ updated_at })).sourceUpdatedAt).toBeNull();
    }
  });
  it('does not label timezone-free, missing or future source data as fresh', async () => {
    for (const updated_at of ['2026-02-05 11:00:00', undefined, '2026-02-06T12:00:00Z']) {
      const fixture = await server((_request, response) => {
        response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(speed({ updated_at })));
      });
      vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
      const connection = (await readIntegrationSnapshot({ configPath: await config({ version: 1, connections: [item(fixture.url)] }), demoMode: false, now: () => now })).connections[0]!;
      expect(connection.status).toBe('connected'); expect(connection.freshness).toBe('unknown');
    }
  });
  it('a secret parent symlink cannot escape the real /run/secrets directory', async () => {
    let calls = 0;
    const fixture = await server((_request, response) => { calls++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(vod)); });
    const outside = await config({ synthetic: 'fixture-secret-file' });
    const tokenPath = '/run/secrets/synthetic-link/token';
    const originalOpen = fs.promises.open.bind(fs.promises);
    const originalRealpath = fs.promises.realpath.bind(fs.promises);
    const realpathSpy = vi.spyOn(fs.promises, 'realpath').mockImplementation(((filename: fs.PathLike, ...args: unknown[]) => {
      if (String(filename) === '/run/secrets/synthetic-link') return Promise.resolve(path.dirname(outside));
      if (String(filename) === tokenPath) return Promise.resolve(outside);
      return (originalRealpath as (...args: unknown[]) => Promise<unknown>)(filename, ...args);
    }) as typeof fs.promises.realpath);
    const openSpy = vi.spyOn(fs.promises, 'open').mockImplementation(((filename: fs.PathLike, ...args: unknown[]) => {
      return (originalOpen as (...args: unknown[]) => Promise<unknown>)(String(filename) === tokenPath ? outside : filename, ...args);
    }) as typeof fs.promises.open);
    vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
    const filename = await config({ version: 1, connections: [item(fixture.url, { kind: 'quark-vod', tokenFile: tokenPath })] });
    const snapshot = await readIntegrationSnapshot({ configPath: filename, demoMode: false, now: () => now });
    expect(snapshot.connections[0]!.status).toBe('error'); expect(calls).toBe(0);
    expect(realpathSpy).toHaveBeenCalledWith('/run/secrets/synthetic-link');
    expect(openSpy.mock.calls.some(args => String(args[0]) === tokenPath || String(args[0]) === outside)).toBe(false);
    expect(JSON.stringify(snapshot)).not.toContain('fixture-secret-file');
    expect(JSON.stringify(snapshot)).not.toContain(outside);
  });
  it('never invents source timestamps from timezone-free text or config file mtime', async () => {
    for (const updated_at of ['2026-02-05 11:00:00', 'yesterday', undefined]) {
      expect(summarizeIntegration('cfspeed', speed({ updated_at })).sourceUpdatedAt).toBeNull();
    }
    expect(summarizeIntegration('cfspeed', speed({ updated_at: '2026-02-05T19:00:00+08:00' })).sourceUpdatedAt).toBe('2026-02-05T11:00:00.000Z');
    expect(summarizeIntegration('quark-vod', vod).sourceUpdatedAt).toBeNull();
    const fixture = await server((_request, response) => { response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(speed({ updated_at: '2025-12-01T00:00:00Z' }))); });
    vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
    const filename = await config({ version: 1, connections: [item(fixture.url)] }); await utimes(filename, new Date(now), new Date(now));
    const connection = (await readIntegrationSnapshot({ configPath: filename, demoMode: false, now: () => now })).connections[0]!;
    expect(connection.observedAt).toBe(new Date(now).toISOString());
    expect(connection.sourceUpdatedAt).toBe('2025-12-01T00:00:00.000Z');
    expect(connection.freshness).toBe('stale');
  });
});

describe('bounded isolated GET transport', () => {
  it('pins the resolved address while retaining origin Host and sends only GET to the requested fixed read endpoint', async () => {
    const requests: { method?: string; url?: string; host?: string; authorization?: string }[] = [];
    const fixture = await server((request, response) => {
      requests.push({ method: request.method, url: request.url, host: request.headers.host, authorization: request.headers.authorization });
      response.setHeader('content-type', 'application/json'); response.end('{"ok":true}');
    });
    expect(await fetchIntegrationJson(fixture.url + '/stats', 'synthetic-bearer', { resolve: fixture.resolve })).toEqual({ ok: true });
    expect(requests).toEqual([{ method: 'GET', url: '/stats', host: new URL(fixture.url).host, authorization: 'Bearer synthetic-bearer' }]);
  });
  it('keeps TLS SNI and certificate hostname tied to the original hostname after DNS pinning', async () => {
    let captured: https.RequestOptions | undefined;
    vi.spyOn(https, 'request').mockImplementation(((options: https.RequestOptions) => {
      captured = options;
      const request = new EventEmitter();
      Object.assign(request, { end: () => queueMicrotask(() => request.emit('error', new Error('synthetic transport stop'))) });
      return request;
    }) as typeof https.request);
    await expect(fetchIntegrationJson('https://synthetic-tls.test/api/results', undefined, { resolve: async target => ({ url: new URL(target), address: '127.0.0.1' }) })).rejects.toMatchObject({ code: 'unavailable' });
    expect(captured!.hostname).toBe('127.0.0.1'); expect(captured!.servername).toBe('synthetic-tls.test');
    expect(captured!.rejectUnauthorized).not.toBe(false);
    const check = captured!.checkServerIdentity!;
    expect(check('127.0.0.1', { subjectaltname: 'DNS:synthetic-tls.test' } as never)).toBeUndefined();
    expect(check('127.0.0.1', { subjectaltname: 'DNS:other.test' } as never)).toBeInstanceOf(Error);
  });
  it('never follows redirects or forwards bearer credentials to redirect targets', async () => {
    let requests = 0;
    const fixture = await server((_request, response) => {
      requests++; response.writeHead(302, { location: '/forbidden' }); response.end();
    });
    await expect(fetchIntegrationJson(fixture.url + '/stats', 'synthetic-bearer', { resolve: fixture.resolve })).rejects.toMatchObject({ code: 'unavailable' });
    expect(requests).toBe(1);
  });
  it('bounds stalled response and stalled DNS by the same deadline', async () => {
    const fixture = await server((_request, _response) => {});
    const started = Date.now();
    await expect(fetchIntegrationJson(fixture.url + '/api/results', undefined, { resolve: fixture.resolve, timeoutMs: 60 })).rejects.toMatchObject({ code: 'timeout' });
    expect(Date.now() - started).toBeLessThan(1500);
    await expect(fetchIntegrationJson(fixture.url, undefined, { resolve: async () => new Promise(() => {}), timeoutMs: 50 })).rejects.toMatchObject({ code: 'timeout' });
  });
  it('rejects announced and streamed bodies over 512KiB', async () => {
    for (const announced of [true, false]) {
      const fixture = await server((_request, response) => {
        response.setHeader('content-type', 'application/json');
        if (announced) response.setHeader('content-length', 512 * 1024 + 1);
        response.end('x'.repeat(512 * 1024 + 1));
      });
      await expect(fetchIntegrationJson(fixture.url, undefined, { resolve: fixture.resolve })).rejects.toMatchObject({ code: 'response_too_large' });
    }
  });
  it('maps unauthorized, invalid JSON, unsupported media and compression to stable errors', async () => {
    for (const [status, media, encoding, body, code] of [
      [401, 'application/json', null, '{"token":"synthetic-marker"}', 'permission_denied'],
      [403, 'application/json', null, '{}', 'permission_denied'],
      [200, 'application/json', null, '{"broken"', 'unsupported_data'],
      [200, 'text/html', null, '<html>synthetic-marker</html>', 'unsupported_data'],
      [200, 'application/json', 'gzip', '{}', 'unsupported_data'],
      [500, 'application/json', null, '{}', 'unavailable'],
    ] as const) {
      const fixture = await server((_request, response) => {
        response.statusCode = status; response.setHeader('content-type', media);
        if (encoding) response.setHeader('content-encoding', encoding); response.end(body);
      });
      await expect(fetchIntegrationJson(fixture.url, undefined, { resolve: fixture.resolve })).rejects.toMatchObject({ code });
    }
  });
  it('rejects metadata, loopback, non-http and credential targets before connection', async () => {
    for (const target of ['http://169.254.169.254/latest/meta-data', 'http://127.0.0.1:9', 'http://[::1]:9', 'file:///etc/passwd', 'http://name:synthetic@127.0.0.1:9', 'http://metadata.google.internal']) {
      await expect(fetchIntegrationJson(target)).rejects.toMatchObject({ code: 'target_blocked' });
    }
  });
});

describe('read cache and route safety', () => {
  it('merges concurrent requests for 30 seconds and preserves last valid metrics on failure as stale', async () => {
    let calls = 0; let failed = false;
    const fixture = await server((_request, response) => {
      calls++; response.setHeader('content-type', 'application/json');
      setTimeout(() => { response.statusCode = failed ? 503 : 200; response.end(JSON.stringify(failed ? { token: 'synthetic-marker' } : speed())); }, 10);
    });
    vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
    const filename = await config({ version: 1, connections: [item(fixture.url)] });
    let time = now;
    const options = { configPath: filename, demoMode: false, now: () => time };
    const [one, two] = await Promise.all([readIntegrationSnapshot(options), readIntegrationSnapshot(options)]);
    expect(calls).toBe(1); expect(one).toEqual(two); expect(one.connections[0]!.status).toBe('connected');
    time += 29000; await readIntegrationSnapshot(options); expect(calls).toBe(1);
    failed = true; time += 2000;
    const stale = (await readIntegrationSnapshot(options)).connections[0]!;
    expect(calls).toBe(2); expect(stale.status).toBe('error'); expect(stale.freshness).toBe('stale');
    expect(stale.metrics).toEqual(one.connections[0]!.metrics);
    expect(stale.observedAt).toBe(one.connections[0]!.observedAt);
    expect(stale.checkedAt).toBe(new Date(time).toISOString());
    expect(stale.errorCode).toBe('unavailable'); expect(JSON.stringify(stale)).not.toContain('synthetic-marker');
    time += 31000;
    const again = (await readIntegrationSnapshot(options)).connections[0]!;
    expect(again.metrics).toEqual(stale.metrics); expect(again.observedAt).toBe(stale.observedAt);
  });
  it('does not retain future-dated cache entries when the wall clock rolls back', async () => {
    let calls = 0;
    const fixture = await server((_request, response) => { calls++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(speed())); });
    vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
    const filename = await config({ version: 1, connections: [item(fixture.url)] });
    let time = now;
    const options = { configPath: filename, demoMode: false, now: () => time };
    await readIntegrationSnapshot(options); expect(calls).toBe(1);
    time -= 60000;
    const result = await readIntegrationSnapshot(options); expect(calls).toBe(2);
    expect(result.connections[0]!.checkedAt).toBe(new Date(time).toISOString());
  });
  it('configured adapters use GET /api/results and never a POST action endpoint', async () => {
    const seen: string[] = [];
    const fixture = await server((request, response) => {
      seen.push(request.method + ' ' + request.url);
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(speed()));
    });
    vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
    await readIntegrationSnapshot({ configPath: await config({ version: 1, connections: [item(fixture.url)] }), demoMode: false, now: () => now });
    expect(seen).toEqual(['GET /api/results']);
  });
  it('Quark uses only GET /stats with an in-boundary secret file and never echoes that bearer', async () => {
    const seen: { method?: string; url?: string; authorization?: string }[] = [];
    const fixture = await server((request, response) => {
      seen.push({ method: request.method, url: request.url, authorization: request.headers.authorization });
      response.setHeader('content-type', 'application/json'); response.end(JSON.stringify({ ...vod, token: 'synthetic-only-bearer' }));
    });
    const tokenStorage = await config({}); await writeFile(tokenStorage, 'synthetic-only-bearer');
    const tokenPath = '/run/secrets/synthetic-token';
    const originalOpen = fs.promises.open.bind(fs.promises);
    const originalRealpath = fs.promises.realpath.bind(fs.promises);
    vi.spyOn(fs.promises, 'realpath').mockImplementation(((filename: fs.PathLike, ...args: unknown[]) => {
      if (String(filename) === '/run/secrets') return Promise.resolve('/run/secrets');
      return (originalRealpath as (...args: unknown[]) => Promise<unknown>)(filename, ...args);
    }) as typeof fs.promises.realpath);
    vi.spyOn(fs.promises, 'open').mockImplementation(((filename: fs.PathLike, ...args: unknown[]) => {
      return (originalOpen as (...args: unknown[]) => Promise<unknown>)(String(filename) === tokenPath ? tokenStorage : filename, ...args);
    }) as typeof fs.promises.open);
    vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
    const filename = await config({ version: 1, connections: [item(fixture.url, { kind: 'quark-vod', tokenFile: tokenPath })] });
    const snapshot = await readIntegrationSnapshot({ configPath: filename, demoMode: false, now: () => now });
    expect(snapshot.connections[0]!.status).toBe('connected');
    expect(seen).toEqual([{ method: 'GET', url: '/stats', authorization: 'Bearer synthetic-only-bearer' }]);
    expect(JSON.stringify(snapshot)).not.toContain('synthetic-only-bearer');
    expect(JSON.stringify(snapshot)).not.toContain(tokenStorage);
    expect(JSON.stringify(snapshot)).not.toContain(tokenPath);
  });
  it('anonymous API reads fail; viewer reads work; mutation/execution routes are absent', async () => {
    const app = Fastify();
    registerIntegrationRoutes(app, async (request, reply) => {
      if (request.headers.authorization !== 'synthetic-viewer') return reply.code(401).send({ error: 'unauthorized' });
    }, { configPath: '/missing', demoMode: true, now: () => now });
    try {
      expect((await app.inject('/api/integrations')).statusCode).toBe(401);
      const headers = { authorization: 'synthetic-viewer' };
      const response = await app.inject({ url: '/api/integrations', headers });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      for (const method of ['POST', 'PATCH', 'DELETE'] as const) for (const url of ['/api/integrations', '/api/integrations/cfspeed/run', '/api/tasks/example/run']) {
        expect((await app.inject({ method, url, headers })).statusCode).toBe(404);
      }
    } finally { await app.close(); }
  });
});

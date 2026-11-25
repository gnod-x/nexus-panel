import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import http from 'node:http';
import { once } from 'node:events';
import type { AddressInfo } from 'node:net';
import * as security from '../../src/server/security.js';
import { fetchIntegrationJson, readIntegrationSnapshot, summarizeIntegration } from '../../src/server/integrations.js';
import { buildApp } from '../../src/server/app.js';
import { Store } from '../../src/server/db.js';

const roots: string[] = [];
const servers: http.Server[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
const stores: Store[] = [];
const oldEnvironment = { ...process.env };
const now = Date.parse('2026-02-05T12:00:00Z');
let sequence = 0;
const speed = { total_scanned: 13, total_verified: 3, jp_recommendations: [], us_recommendations: [], scanning: false, updated_at: '2026-02-05T11:59:00Z' };
const vod = { done: 8, pending: 1, searching: 2, found: 1, saving: 0, failed: 2, plays: 16 };
async function local(handler: http.RequestListener) {
  const app = http.createServer(handler); servers.push(app); app.listen(0, '127.0.0.1'); await once(app, 'listening');
  const url = 'http://adapter-security.audit.invalid:' + (app.address() as AddressInfo).port;
  const resolve = async (target: string) => ({ url: new URL(target), address: '127.0.0.1' });
  return { app, url, resolve };
}
async function directory() { const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-audit-integration-')); roots.push(root); return root; }
async function config(baseUrl: string, changes: Record<string, unknown> = {}) {
  const root = await directory(); const filename = path.join(root, 'config.json');
  await writeFile(filename, JSON.stringify({ version: 1, connections: [{ id: 'security-' + ++sequence, name: 'Synthetic adapter', kind: 'cfspeed', baseUrl, ...changes }] }));
  return filename;
}
async function virtualToken(contents: string, asSymlink = false) {
  const root = await directory(); const storage = path.join(root, 'synthetic-token'); await writeFile(storage, contents);
  let backing = storage;
  if (asSymlink) { backing = path.join(root, 'token-link'); await symlink(storage, backing); }
  const tokenPath = '/run/secrets/audit-synthetic-token';
  const realOpen = fs.promises.open.bind(fs.promises); const realRealpath = fs.promises.realpath.bind(fs.promises);
  vi.spyOn(fs.promises, 'realpath').mockImplementation(((filename: fs.PathLike, ...args: unknown[]) => {
    if (String(filename) === '/run/secrets') return Promise.resolve('/run/secrets');
    return (realRealpath as (...args: unknown[]) => Promise<unknown>)(filename, ...args);
  }) as typeof fs.promises.realpath);
  vi.spyOn(fs.promises, 'open').mockImplementation(((filename: fs.PathLike, ...args: unknown[]) => {
    return (realOpen as (...args: unknown[]) => Promise<unknown>)(String(filename) === tokenPath ? backing : filename, ...args);
  }) as typeof fs.promises.open);
  return tokenPath;
}
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(apps.splice(0).map(app => app.close())); for (const store of stores.splice(0)) store.db.close();
  for (const app of servers.splice(0)) { app.closeAllConnections(); await new Promise<void>(resolve => app.close(() => resolve())); }
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const key of ['INTEGRATION_CONFIG_PATH','INTEGRATION_DEMO_MODE','TASK_DEMO_MODE','PUBLIC_ORIGIN','NODE_ENV']) {
    if (oldEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = oldEnvironment[key];
  }
});

describe('audit secret-file and credential transport edges', () => {
  it.each(['','  ','first\nsecond','first\rsecond','first\0second','x'.repeat(4097)])('invalid synthetic token fixture #%# never makes an outbound request', async token => {
    let requests = 0;
    const fixture = await local((_request, response) => { requests++; response.setHeader('content-type', 'application/json'); response.end(JSON.stringify(vod)); });
    const tokenFile = await virtualToken(token);
    vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
    const snapshot = await readIntegrationSnapshot({ configPath: await config(fixture.url, { kind: 'quark-vod', tokenFile }), demoMode: false, now: () => now });
    const item = snapshot.connections[0]!;
    expect(item.status).toBe('error'); expect(item.errorCode).toBe('config_invalid'); expect(item.metrics).toEqual([]);
    expect(requests).toBe(0); expect(JSON.stringify(snapshot)).not.toContain(tokenFile);
  });
  it('final token-file symlinks remain forbidden even with an allowed real parent', async () => {
    let requests = 0;
    const fixture = await local((_request, response) => { requests++; response.setHeader('content-type','application/json'); response.end(JSON.stringify(vod)); });
    const tokenFile = await virtualToken('SYNTHETIC_SYMLINK_SECRET', true);
    vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
    const snapshot = await readIntegrationSnapshot({ configPath: await config(fixture.url, { kind:'quark-vod', tokenFile }), demoMode:false, now:()=>now });
    expect(snapshot.connections[0]!.status).toBe('error'); expect(requests).toBe(0);
    expect(JSON.stringify(snapshot)).not.toContain('SYNTHETIC_SYMLINK_SECRET');
  });
  it('exact 4096-byte token boundary is usable and only edge whitespace is trimmed', async () => {
    let received = '';
    const fixture = await local((request, response) => { received = request.headers.authorization || ''; response.setHeader('content-type','application/json'); response.end(JSON.stringify(vod)); });
    const tokenFile = await virtualToken('x'.repeat(4096));
    vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
    const snapshot = await readIntegrationSnapshot({ configPath: await config(fixture.url, { kind:'quark-vod', tokenFile }), demoMode:false, now:()=>now });
    expect(snapshot.connections[0]!.status).toBe('connected'); expect(received).toBe('Bearer ' + 'x'.repeat(4096));
    expect(JSON.stringify(snapshot)).not.toContain('x'.repeat(100));
  });
  it('ordinary token-file trailing newline is allowed without forwarding that newline', async () => {
    let received = '';
    const fixture = await local((request, response) => { received = request.headers.authorization || ''; response.setHeader('content-type','application/json'); response.end(JSON.stringify(vod)); });
    const tokenFile = await virtualToken(' SYNTHETIC_EDGE_TOKEN\n');
    vi.spyOn(security, 'resolveTarget').mockImplementation(fixture.resolve);
    const snapshot = await readIntegrationSnapshot({ configPath: await config(fixture.url, { kind:'quark-vod', tokenFile }), demoMode:false, now:()=>now });
    expect(snapshot.connections[0]!.status).toBe('connected'); expect(received).toBe('Bearer SYNTHETIC_EDGE_TOKEN');
    expect(JSON.stringify(snapshot)).not.toContain('SYNTHETIC_EDGE_TOKEN');
  });
  it.each(['/run/secrets/../outside','/run/secrets/./token','run/secrets/token','/run/secrets//token','/run/secrets/'])('noncanonical token path %s fails schema before networking', async tokenFile => {
    const resolver = vi.spyOn(security, 'resolveTarget');
    const snapshot = await readIntegrationSnapshot({ configPath: await config('https://no-contact.audit.invalid', { kind:'quark-vod', tokenFile }), demoMode:false, now:()=>now });
    expect(snapshot.connections.every(item => item.errorCode === 'config_invalid')).toBe(true); expect(resolver).not.toHaveBeenCalled();
  });
  it('cross-origin redirects never receive a bearer credential', async () => {
    let targetRequests = 0;
    const destination = await local((_request, response) => { targetRequests++; response.setHeader('content-type','application/json'); response.end('{}'); });
    const first = await local((_request, response) => { response.writeHead(307, { location: destination.url + '/captured' }); response.end(); });
    await expect(fetchIntegrationJson(first.url + '/stats', 'SYNTHETIC_REDIRECT_SECRET', { resolve:first.resolve })).rejects.toMatchObject({ code:'unavailable' });
    expect(targetRequests).toBe(0);
  });
});

describe('audit integration production deadline and shared-read isolation', () => {
  it('default four-second production deadline closes an unfinished body stream', async () => {
    let close!: () => void;
    const closed = new Promise<void>(resolve => { close = resolve; });
    const fixture = await local((_request, response) => {
      response.on('close', close); response.writeHead(200, { 'content-type':'application/json' }); response.write('{"unfinished":');
    });
    const started = Date.now();
    await expect(fetchIntegrationJson(fixture.url, undefined, { resolve:fixture.resolve })).rejects.toMatchObject({ code:'timeout' });
    expect(Date.now()-started).toBeGreaterThanOrEqual(3700); expect(Date.now()-started).toBeLessThan(7500);
    await closed;
  }, 10000);
  it('query parameters and request authorization cannot configure the real API', async () => {
    const root = await directory();
    process.env.INTEGRATION_CONFIG_PATH = path.join(root,'missing-config.json'); process.env.INTEGRATION_DEMO_MODE='false'; process.env.TASK_DEMO_MODE='true'; process.env.NODE_ENV='test'; delete process.env.PUBLIC_ORIGIN;
    const store = new Store(':memory:'); stores.push(store);
    const user = store.createUser('integration-reader@audit.example.test','unused-hash','viewer');
    store.saveSession(security.tokenHash('integration-viewer-synthetic'),user.id,new Date(Date.now()+60000).toISOString());
    const app = buildApp(store); apps.push(app);
    const resolver = vi.spyOn(security,'resolveTarget');
    const response = await app.inject({ url:'/api/integrations?baseUrl=http://127.0.0.1&token=QUERY_PRIVATE_MARKER&demoMode=true&configPath=/etc/passwd',
      headers:{ cookie:'nexus_session=integration-viewer-synthetic',authorization:'Bearer HEADER_PRIVATE_MARKER' } });
    expect(response.statusCode).toBe(200); expect(response.json().snapshot.mode).toBe('unconfigured'); expect(resolver).not.toHaveBeenCalled();
    expect(response.body).not.toContain('QUERY_PRIVATE_MARKER'); expect(response.body).not.toContain('HEADER_PRIVATE_MARKER');
  });
  it('configured base paths are preserved but only the fixed read endpoint is appended', async () => {
    const requests:string[]=[];
    const fixture=await local((request,response)=>{requests.push(request.method+' '+request.url);response.setHeader('content-type','application/json');response.end(JSON.stringify(speed));});
    vi.spyOn(security,'resolveTarget').mockImplementation(fixture.resolve);
    const snapshot=await readIntegrationSnapshot({ configPath:await config(fixture.url+'/synthetic-prefix/'),demoMode:false,now:()=>now });
    expect(snapshot.connections[0]!.status).toBe('connected');expect(requests).toEqual(['GET /synthetic-prefix/api/results']);
  });
  it('20 concurrent authenticated-style reads coalesce into exactly one upstream attempt', async () => {
    let calls=0;let release!:()=>void;
    const gate=new Promise<void>(resolve=>{release=resolve;});
    const fixture=await local(async(_request,response)=>{calls++;await gate;response.setHeader('content-type','application/json');response.end(JSON.stringify(speed));});
    vi.spyOn(security,'resolveTarget').mockImplementation(fixture.resolve);
    const filename=await config(fixture.url);
    const requests=Array.from({length:20},()=>readIntegrationSnapshot({configPath:filename,demoMode:false,now:()=>now}));
    // Releasing the HTTP response is a dependency gate, not an artificial delay.
    release();
    const snapshots=await Promise.all(requests);expect(calls).toBe(1);
    expect(snapshots.every(snapshot=>snapshot.connections[0]!.status==='connected')).toBe(true);
    expect(snapshots.every(snapshot=>JSON.stringify(snapshot)===JSON.stringify(snapshots[0]))).toBe(true);
  });
  it('failure cache does not retain a sensitive unsupported upstream body', async () => {
    let calls=0;
    const fixture=await local((_request,response)=>{calls++;response.setHeader('content-type','application/json');response.end('{"token":"SYNTHETIC_UPSTREAM_PRIVATE_PAYLOAD"}');});
    vi.spyOn(security,'resolveTarget').mockImplementation(fixture.resolve);
    const filename=await config(fixture.url);const options={configPath:filename,demoMode:false,now:()=>now};
    const first=await readIntegrationSnapshot(options);const second=await readIntegrationSnapshot(options);
    expect(calls).toBe(1);expect(first.connections[0]!.errorCode).toBe('unsupported_data');expect(first.connections[0]!.metrics).toEqual([]);
    expect(JSON.stringify(second)).not.toContain('SYNTHETIC_UPSTREAM_PRIVATE_PAYLOAD');
  });
  it('every primitive and nonfinite/string counter is rejected by the summary whitelist', () => {
    for(const value of [null,true,0,'synthetic',[],{},{...vod,done:'8'},{...vod,done:NaN},{...vod,done:Infinity},{...vod,done:-1}]){
      expect(()=>summarizeIntegration('quark-vod',value)).toThrow();
    }
  });
  it('real API integration reads are revoked immediately with the underlying session', async () => {
    process.env.INTEGRATION_DEMO_MODE='true';process.env.TASK_DEMO_MODE='true';process.env.NODE_ENV='test';delete process.env.PUBLIC_ORIGIN;
    const store=new Store(':memory:');stores.push(store);
    const user=store.createUser('revoked@audit.example.test','unused-hash','viewer');const token='revoked-integration-synthetic';
    store.saveSession(security.tokenHash(token),user.id,new Date(Date.now()+60000).toISOString());
    const app=buildApp(store);apps.push(app);
    const headers={cookie:'nexus_session='+token};
    expect((await app.inject({url:'/api/integrations',headers})).statusCode).toBe(200);
    store.deleteSession(security.tokenHash(token));
    expect((await app.inject({url:'/api/integrations',headers})).statusCode).toBe(401);
  });
});

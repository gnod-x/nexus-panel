import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { buildApp } from '../../src/server/app.js';
import { Store } from '../../src/server/db.js';
import * as security from '../../src/server/security.js';
import * as health from '../../src/server/health.js';
import type { Role } from '../../src/server/types.js';

// Only in-memory data and synthetic identifiers; no listener or real service contact.
const envKeys = ['PUBLIC_ORIGIN','TASK_DEMO_MODE','INTEGRATION_DEMO_MODE','HEALTH_ALLOWED_CIDRS','NODE_ENV'] as const;
let environment: Record<string, string | undefined>;
let store: Store;
let app: ReturnType<typeof buildApp>;
const users: Record<string, number> = {};
const cookies: Record<string, string> = {};
const rawTokens: Record<string, string> = {};
const password = 'audit synthetic password never used outside memory';
const hash = security.hashPassword(password);
let groupId: number;
let serviceId: number;
function headers(role = 'admin', extra: Record<string, string> = {}) {
  return { 'content-type': 'application/json', cookie: cookies[role]!, ...extra };
}
function snapshot() { return { groups: store.listGroups(), services: store.listServices(), events: store.listEvents() }; }
beforeEach(async () => {
  environment = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  delete process.env.PUBLIC_ORIGIN;
  process.env.NODE_ENV = 'test';
  process.env.TASK_DEMO_MODE = 'true'; process.env.INTEGRATION_DEMO_MODE = 'true';
  store = new Store(':memory:');
  for (const role of ['admin','operator','viewer'] as const) {
    users[role] = store.createUser(role + '@audit.example.test', hash, role).id;
    rawTokens[role] = 'synthetic-audit-' + role;
    store.saveSession(security.tokenHash(rawTokens[role]!), users[role]!, new Date(Date.now() + 3600000).toISOString());
    cookies[role] = 'nexus_session=' + rawTokens[role];
  }
  groupId = store.createGroup({ name: 'Synthetic seed group', slug: 'seed-group' }).id;
  serviceId = store.createService({ name: 'Synthetic seed service', slug: 'seed-service', groupId, url: 'https://seed.audit.invalid/' }).id;
  app = buildApp(store); await app.ready();
});
afterEach(async () => {
  vi.restoreAllMocks(); await app.close(); store.db.close();
  for (const key of envKeys) if (environment[key] === undefined) delete process.env[key]; else process.env[key] = environment[key];
});

const reads = ['/api/auth/me','/api/groups','/api/services','/api/overview','/api/events','/api/tasks','/api/tasks/demo-backup','/api/integrations'];
describe('audit real buildApp authentication and workspace role matrix', () => {
  it.each(reads)('anonymous cannot read %s', async url => {
    expect((await app.inject(url)).statusCode).toBe(401);
    expect((await app.inject({ url, headers: { cookie: 'nexus_session=forged-synthetic-cookie' } })).statusCode).toBe(401);
  });
  it.each(['admin','operator','viewer'])('%s may read every shared-workspace collection, including observability', async role => {
    for (const url of reads) {
      const response = await app.inject({ url, headers: headers(role) });
      expect(response.statusCode, url).toBe(200);
      expect(response.body).not.toContain('passwordHash'); expect(response.body).not.toContain(rawTokens[role]!);
    }
  });
  const actions = [
    { name: 'create group', method: 'POST', url: () => '/api/groups', payload: () => ({ name: 'New group', slug: 'new-group' }), operator: true, expected: 201 },
    { name: 'edit group', method: 'PATCH', url: () => '/api/groups/' + groupId, payload: () => ({ name: 'Changed group' }), operator: true, expected: 200 },
    { name: 'delete group', method: 'DELETE', url: () => '/api/groups/' + groupId, payload: () => ({}), operator: false, expected: 200 },
    { name: 'create service', method: 'POST', url: () => '/api/services', payload: () => ({ name: 'New service', slug: 'new-service', groupId, url: 'https://new.audit.invalid/' }), operator: true, expected: 201 },
    { name: 'edit service', method: 'PATCH', url: () => '/api/services/' + serviceId, payload: () => ({ name: 'Changed service' }), operator: true, expected: 200 },
    { name: 'delete service', method: 'DELETE', url: () => '/api/services/' + serviceId, payload: () => ({}), operator: false, expected: 200 },
    { name: 'check service', method: 'POST', url: () => '/api/services/' + serviceId + '/check', payload: () => ({}), operator: true, expected: 200 },
    { name: 'import', method: 'POST', url: () => '/api/import/sun-panel', payload: () => ({ groups: [{ name: 'Imported group', slug: 'imported-group' }], services: [] }), operator: false, expected: 200 },
  ] as const;
  for (const role of ['admin','operator','viewer'] as const) for (const action of actions) {
    it(role + ' role: ' + action.name, async () => {
      vi.spyOn(security, 'validateTargetUrl').mockImplementation(async value => new URL(value));
      const probe = vi.spyOn(health, 'probeHealth').mockResolvedValue(204);
      const before = snapshot();
      const response = await app.inject({ method: action.method, url: action.url(), headers: headers(role), payload: action.payload() });
      const allowed = role === 'admin' || role === 'operator' && action.operator;
      expect(response.statusCode).toBe(allowed ? action.expected : 403);
      if (!allowed) { expect(snapshot()).toEqual(before); expect(probe).not.toHaveBeenCalled(); }
    });
  }
  it('IDs never override viewer authorization on another workspace record', async () => {
    const another = store.createService({ name: 'Second shared entry', slug: 'second-service', url: 'https://second.audit.invalid/' });
    const before = snapshot();
    for (const id of [serviceId, another.id, 999999]) for (const method of ['PATCH','DELETE'] as const) {
      const response = await app.inject({ method, url: '/api/services/' + id, headers: headers('viewer'), payload: { name: 'Unauthorized change' } });
      expect(response.statusCode).toBe(403);
    }
    expect(snapshot()).toEqual(before);
    // This is intentionally one shared workspace, not per-user service tenancy.
    expect((await app.inject({ url: '/api/services', headers: headers('viewer') })).json().services).toHaveLength(2);
  });
  it('none of the observed task/integration management endpoints exist, even for admin', async () => {
    for (const method of ['POST','PUT','PATCH','DELETE'] as const) for (const url of ['/api/tasks','/api/tasks/demo-backup','/api/tasks/demo-backup/run','/api/integrations','/api/integrations/cfspeed/scan','/api/integrations/quark-vod/save']) {
      const response = await app.inject({ method, url, headers: headers(), payload: {} });
      expect(response.statusCode, method + ' ' + url).toBe(404);
    }
  });
});

describe('audit session lifecycle and current authorization', () => {
  it('only token hashes are persisted; guessing account IDs does not authenticate', async () => {
    const rows = store.db.prepare('SELECT token_hash FROM sessions').all() as { token_hash: string }[];
    expect(rows).toHaveLength(3);
    for (const row of rows) { expect(row.token_hash).toMatch(/^[0-9a-f]{64}$/); expect(Object.values(rawTokens)).not.toContain(row.token_hash); }
    for (const cookie of ['nexus_session=1','nexus_session=admin','userId=1','nexus_session=%7B%22userId%22%3A1%7D']) {
      expect((await app.inject({ url: '/api/auth/me', headers: { cookie } })).statusCode).toBe(401);
    }
  });
  it('logout revokes only the current token and cannot be reused', async () => {
    const second = 'synthetic-audit-admin-second';
    store.saveSession(security.tokenHash(second), users.admin!, new Date(Date.now() + 60000).toISOString());
    expect((await app.inject({ method: 'POST', url: '/api/auth/logout', headers: headers(), payload: {} })).statusCode).toBe(200);
    for (const url of ['/api/auth/me','/api/tasks','/api/integrations']) expect((await app.inject({ url, headers: headers() })).statusCode).toBe(401);
    expect((await app.inject({ url: '/api/auth/me', headers: { cookie: 'nexus_session=' + second } })).statusCode).toBe(200);
  });
  it('expired sessions fail both reads and writes without changing data', async () => {
    store.db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run('2000-01-01T00:00:00.000Z', users.admin!);
    const before = snapshot();
    for (const url of reads) expect((await app.inject({ url, headers: headers() })).statusCode).toBe(401);
    expect((await app.inject({ method: 'PATCH', url: '/api/services/' + serviceId, headers: headers(), payload: { name: 'No change' } })).statusCode).toBe(401);
    expect(snapshot()).toEqual(before);
  });
  it('malformed persisted expiry must fail closed, rather than creating a permanent session', async () => {
    store.db.prepare('UPDATE sessions SET expires_at=? WHERE user_id=?').run('not-a-valid-expiry', users.admin!);
    expect((await app.inject({ url: '/api/auth/me', headers: headers() })).statusCode).toBe(401);
  });
  it('deleting a user cascades sessions and invalidates their cookie', async () => {
    store.db.prepare('DELETE FROM users WHERE id=?').run(users.viewer!);
    expect((await app.inject({ url: '/api/tasks', headers: headers('viewer') })).statusCode).toBe(401);
    expect(store.db.prepare('SELECT COUNT(*) AS n FROM sessions WHERE user_id=?').get(users.viewer!)).toEqual({ n: 0 });
  });
  it('role downgrade applies on the next request rather than trusting a cached session role', async () => {
    store.db.prepare('UPDATE users SET role=? WHERE id=?').run('viewer', users.admin!);
    const before = snapshot();
    expect((await app.inject({ method: 'DELETE', url: '/api/services/' + serviceId, headers: headers(), payload: {} })).statusCode).toBe(403);
    expect((await app.inject({ url: '/api/auth/me', headers: headers() })).json().user.role).toBe('viewer');
    expect(snapshot()).toEqual(before);
  });
  it('unknown persisted roles fail authentication', async () => {
    store.db.prepare('UPDATE users SET role=? WHERE id=?').run('superuser', users.viewer!);
    expect((await app.inject({ url: '/api/services', headers: headers('viewer') })).statusCode).toBe(401);
  });
  it('successful logins rotate random tokens; invalid credentials have one stable error', async () => {
    const first = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'admin@audit.example.test', password } });
    const second = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: { email: 'admin@audit.example.test', password } });
    expect(first.statusCode).toBe(200); expect(second.statusCode).toBe(200);
    expect(first.headers['set-cookie']).not.toBe(second.headers['set-cookie']);
    expect(first.body).not.toContain('passwordHash'); expect(first.body).not.toContain(hash);
    for (const email of ['missing@audit.example.test','admin@audit.example.test']) {
      const failed = await app.inject({ method: 'POST', url: '/api/auth/login', headers: { 'content-type': 'application/json' }, payload: { email, password: 'synthetic incorrect' } });
      expect(failed.statusCode).toBe(401); expect(failed.json()).toEqual({ error: 'invalid_credentials' });
    }
  });
});

describe('audit transport constraints and errors', () => {
  it.each(['text/plain','application/xml','text/html','application/octet-stream'])('unsupported request media %s is a controlled 415, never 500', async media => {
    const before = snapshot();
    const response = await app.inject({ method: 'POST', url: '/api/groups', headers: headers('admin', { 'content-type': media }), payload: '{"name":"No change","slug":"no-change"}' });
    expect(response.statusCode).toBe(415); expect(snapshot()).toEqual(before);
  });
  it('invalid JSON is controlled 400 and does not expose parse fragments', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/groups', headers: headers(), payload: '{"synthetic-private-marker":' });
    expect(response.statusCode).toBe(400); expect(response.body).not.toContain('synthetic-private-marker');
  });
  it.each(['https://untrusted.audit.invalid','null','https://user:synthetic@localhost','https://localhost/path'])('foreign Origin %s cannot mutate as admin', async origin => {
    const before = snapshot();
    const response = await app.inject({ method: 'POST', url: '/api/groups', headers: headers('admin', { origin, 'x-forwarded-host': 'untrusted.audit.invalid' }), payload: { name: 'Denied', slug: 'denied' } });
    expect(response.statusCode).toBe(403); expect(snapshot()).toEqual(before);
  });
  it('server-wide 2MiB body cap returns 413 and never reflects submitted material', async () => {
    const response = await app.inject({ method: 'POST', url: '/api/groups', headers: headers(), payload: '{"synthetic-marker":"' + 'x'.repeat(2 * 1024 * 1024) + '"}' });
    expect(response.statusCode).toBe(413); expect(response.body).not.toContain('synthetic-marker');
  });
  it.each(['abc','Infinity','1.5','NaN','-Infinity','0x10','1e3',''])('event query limit %s remains controlled and returns at most 200', async limit => {
    for (let index = 0; index < 5; index++) store.addEvent(null, 'synthetic', 'Synthetic event', {});
    const response = await app.inject({ url: '/api/events?limit=' + encodeURIComponent(limit), headers: headers('viewer') });
    expect(response.statusCode).toBe(200);
    expect(response.json().events.length).toBeLessThanOrEqual(200);
  });
  it.each(['NaN','Infinity','-1','1.5','9007199254740993','1e0','0x1','1.0','0','%201','1%20'])('noncanonical path ID %s cannot touch a valid record or cause 500', async invalidId => {
    const before = snapshot();
    vi.spyOn(health, 'probeHealth').mockResolvedValue(204);
    for (const [method, url, payload] of [
      ['PATCH', '/api/groups/' + invalidId, { name: 'Unexpected alias' }],
      ['DELETE', '/api/groups/' + invalidId, {}],
      ['PATCH', '/api/services/' + invalidId, { name: 'Unexpected alias' }],
      ['DELETE', '/api/services/' + invalidId, {}],
      ['POST', '/api/services/' + invalidId + '/check', {}],
    ] as const) {
      const response = await app.inject({ method, url, headers: headers(), payload });
      expect([400,404], method + ' ' + url + ': ' + response.body).toContain(response.statusCode);
      expect(snapshot()).toEqual(before);
    }
  });
  it.each(['POST','PATCH'])('unknown service group on %s is controlled 4xx and atomic', async method => {
    vi.spyOn(security, 'validateTargetUrl').mockImplementation(async value => new URL(value));
    const before = snapshot();
    const response = await app.inject({
      method: method as 'POST' | 'PATCH', url: '/api/services' + (method === 'PATCH' ? '/' + serviceId : ''),
      headers: headers(), payload: method === 'PATCH' ? { groupId: 999999, name: 'Rejected update' } : { groupId: 999999, name: 'Rejected new entry', slug: 'rejected-service', url: 'https://service.audit.invalid/' },
    });
    expect([400,404,409]).toContain(response.statusCode); expect(snapshot()).toEqual(before);
  });
});

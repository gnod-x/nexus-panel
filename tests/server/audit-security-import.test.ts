import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Store } from '../../src/server/db.js';
import { buildApp } from '../../src/server/app.js';
import * as security from '../../src/server/security.js';

let store: Store;
let app: ReturnType<typeof buildApp>;
let oldEnvironment: Record<string, string | undefined>;
const cookie = 'nexus_session=synthetic-import-audit-session';
const headers = { 'content-type': 'application/json', cookie };
const envKeys = ['PUBLIC_ORIGIN','TASK_DEMO_MODE','INTEGRATION_DEMO_MODE','NODE_ENV'] as const;
const service = (slug = 'audit-service', changes: Record<string, unknown> = {}) => ({ name: 'Synthetic import service', slug, url: 'https://' + slug + '.audit.invalid/', ...changes });
const current = () => ({ groups: store.listGroups(), services: store.listServices(), events: store.listEvents() });
beforeEach(async () => {
  oldEnvironment = Object.fromEntries(envKeys.map(key => [key, process.env[key]]));
  delete process.env.PUBLIC_ORIGIN; process.env.NODE_ENV = 'test'; process.env.TASK_DEMO_MODE = 'true'; process.env.INTEGRATION_DEMO_MODE = 'true';
  store = new Store(':memory:');
  const user = store.createUser('import-audit@example.test', 'unneeded synthetic hash', 'admin');
  store.saveSession(security.tokenHash('synthetic-import-audit-session'), user.id, new Date(Date.now() + 3600000).toISOString());
  const group = store.createGroup({ name: 'Preserved group', slug: 'preserved-group' });
  store.createService({ name: 'Preserved service', slug: 'preserved-service', url: 'https://preserved.audit.invalid/', groupId: group.id });
  store.addEvent(null, 'synthetic-baseline', 'Preserved event', {});
  vi.spyOn(security, 'validateTargetUrl').mockImplementation(async value => {
    const url = new URL(value);
    if (url.hostname === 'blocked.audit.invalid') throw new Error('synthetic sensitive network diagnostic not for API');
    return url;
  });
  app = buildApp(store); await app.ready();
});
afterEach(async () => {
  await app.close(); store.db.close(); vi.restoreAllMocks();
  for (const key of envKeys) if (oldEnvironment[key] === undefined) delete process.env[key]; else process.env[key] = oldEnvironment[key];
});
const send = (payload: unknown) => app.inject({ method: 'POST', url: '/api/import/sun-panel', headers, payload });

describe('audit import transaction atomicity', () => {
  it('late missing-group failure rolls back newly inserted groups, first service and event', async () => {
    const before = current();
    const response = await send({ groups: [{ name: 'New group', slug: 'new-group' }], services: [
      service('first-new', { groupSlug: 'new-group' }), service('second-new', { groupSlug: 'missing-group' }),
    ] });
    expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error: 'missing_group' }); expect(current()).toEqual(before);
  });
  it('late duplicate service rolls back all earlier rows while preserving existing data', async () => {
    const before = current();
    const response = await send({ groups: [{ name: 'New group', slug: 'new-group' }], services: [
      service('first-new', { groupSlug: 'new-group' }), service('preserved-service', { groupSlug: 'new-group' }),
    ] });
    expect(response.statusCode).toBe(409); expect(current()).toEqual(before);
  });
  it('duplicate service IDs within one batch also roll back its newly created group', async () => {
    const before = current();
    const response = await send({ groups: [{ name: 'New group', slug: 'new-group' }], services: [service('same'), service('same')] });
    expect(response.statusCode).toBe(409); expect(current()).toEqual(before);
  });
  it('an invalid final URL is rejected before any transaction write and never echoes errors', async () => {
    const before = current();
    const response = await send({ groups: [{ name: 'New group', slug: 'new-group' }], services: [
      service('first-new'), service('second-new', { healthUrl: 'https://blocked.audit.invalid/private-marker' }),
    ] });
    expect(response.statusCode).toBe(400); expect(response.json()).toEqual({ error: 'invalid_target' });
    expect(current()).toEqual(before);
    expect(response.body).not.toContain('private-marker'); expect(response.body).not.toContain('sensitive network diagnostic');
  });
  it('existing groupSlug may be referenced without recreating or rewriting its group', async () => {
    const groupBefore = store.listGroups()[0]!;
    const response = await send({ groups: [], services: [service('linked', { groupSlug: 'preserved-group' })] });
    expect(response.statusCode).toBe(200);
    expect(store.listGroups()).toEqual([groupBefore]);
    expect(store.listServices().find(row => row.slug === 'linked')!.groupId).toBe(groupBefore.id);
  });
  it('import metadata and event only expose counts, not service URLs or upstream tokens', async () => {
    const response = await send({ groups: [], services: [service('private-metadata', { url: 'https://private.audit.invalid/synthetic-private-marker' })] });
    expect(response.statusCode).toBe(200);
    const event = store.listEvents()[0]!;
    expect(event.metadata).toEqual({ groups: 0, services: 1 });
    expect(JSON.stringify(event)).not.toContain('private.audit'); expect(JSON.stringify(event)).not.toContain('synthetic-private-marker');
  });
});

describe('audit import/schema boundary cases', () => {
  it.each([
    ['null body', null],
    ['array body', []],
    ['missing groups', { services: [] }],
    ['missing services', { groups: [] }],
    ['null groups', { groups: null, services: [] }],
    ['group null', { groups: [null], services: [] }],
    ['service null', { groups: [], services: [null] }],
    ['empty group name', { groups: [{ name: ' ', slug: 'blank' }], services: [] }],
    ['oversized group name', { groups: [{ name: '文'.repeat(81), slug: 'long' }], services: [] }],
    ['invalid group slug', { groups: [{ name: 'Invalid', slug: '../escape' }], services: [] }],
    ['oversized service name', { groups: [], services: [service('long', { name: 'x'.repeat(101) })] }],
    ['oversized description', { groups: [], services: [service('long', { description: 'x'.repeat(501) })] }],
    ['too many tags', { groups: [], services: [service('tags', { tags: Array(21).fill('tag') })] }],
    ['oversized tag', { groups: [], services: [service('tags', { tags: ['x'.repeat(41)] })] }],
    ['invalid group color', { groups: [{ name: 'Color', slug: 'color', color: 'url(synthetic)' }], services: [] }],
  ])('rejects %s without touching rows', async (_name, payload) => {
    const before = current(); const response = await send(payload);
    expect(response.statusCode).toBe(400); expect(current()).toEqual(before);
  });
  it('accepts maximum 100 groups and 500 services using only synthetic validator fixtures', async () => {
    const payload = {
      groups: Array.from({ length: 100 }, (_, index) => ({ name: 'Synthetic group ' + index, slug: 'audit-group-' + index })),
      services: Array.from({ length: 500 }, (_, index) => service('audit-' + index, { groupSlug: 'audit-group-' + index % 100 })),
    };
    const response = await send(payload); expect(response.statusCode).toBe(200); expect(response.json()).toEqual({ imported: { groups: 100, services: 500 } });
    expect(store.listGroups()).toHaveLength(101); expect(store.listServices()).toHaveLength(501);
  });
  it('accepts exact text/tag boundaries and strips forbidden mass-assignment metadata', async () => {
    const response = await send({
      groups: [{ name: '文'.repeat(80), slug: 'boundary', createdAt: 'synthetic', sortOrder: 999 }],
      services: [service('boundary', { name: 'n'.repeat(100), description: 'd'.repeat(500), tags: Array(20).fill('t'.repeat(40)), groupSlug: 'boundary', status: 'healthy', latencyMs: 0, lastCheckedAt: '2000-01-01T00:00:00Z', role: 'admin', token: 'synthetic-private-marker', command: 'synthetic-private-marker' })],
    });
    expect(response.statusCode).toBe(200);
    const row = store.listServices().find(row => row.slug === 'boundary')!;
    expect(row.status).toBe('unknown'); expect(row.lastCheckedAt).toBeNull(); expect(row.latencyMs).toBeNull();
    expect(JSON.stringify(row)).not.toContain('synthetic-private-marker');
    expect(store.listGroups().find(group => group.slug === 'boundary')!.sortOrder).toBe(0);
  });
  it('SQL-looking names remain literal data and cannot change account tables', async () => {
    const name = "Synthetic'); DROP TABLE users;--";
    const response = await send({ groups: [{ name, slug: 'sql-literal' }], services: [] });
    expect(response.statusCode).toBe(200); expect(store.userCount()).toBe(1);
    expect(store.listGroups().find(group => group.slug === 'sql-literal')!.name).toBe(name);
  });
  it('prototype-bearing JSON cannot mutate runtime prototypes or create imported rows', async () => {
    const before = current();
    const response = await send('{"groups":[],"services":[],"__proto__":{"syntheticPolluted":true}}');
    expect([400,200]).toContain(response.statusCode);
    expect(({} as Record<string, unknown>).syntheticPolluted).toBeUndefined();
    expect(store.listGroups()).toEqual(before.groups); expect(store.listServices()).toEqual(before.services);
  });
  it('one MiB is enforced on actual request bytes including otherwise-ignored whitespace', async () => {
    const before = current();
    const response = await send(' '.repeat(1024 * 1024) + '{"groups":[],"services":[]}');
    expect(response.statusCode).toBe(413); expect(current()).toEqual(before);
  });
  it('normalized JSON above one MiB returns controlled 413 without mutation', async () => {
    const before = current();
    const response = await send({ groups: [], services: [], extra: 'x'.repeat(1024 * 1024) });
    expect(response.statusCode).toBe(413); expect(current()).toEqual(before);
  });
  it('concurrent duplicate imports commit exactly one copy and one import event', async () => {
    const payload = { groups: [{ name: 'Concurrent group', slug: 'concurrent' }], services: [service('concurrent', { groupSlug: 'concurrent' })] };
    const responses = await Promise.all([send(payload), send(payload), send(payload)]);
    expect(responses.map(response => response.statusCode).sort()).toEqual([200,409,409]);
    expect(store.listGroups().filter(group => group.slug === 'concurrent')).toHaveLength(1);
    expect(store.listServices().filter(service => service.slug === 'concurrent')).toHaveLength(1);
    expect(store.listEvents().filter(event => event.type === 'import')).toHaveLength(1);
  });
});

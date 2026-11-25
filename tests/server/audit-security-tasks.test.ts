import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, writeFile, rm, rename, stat } from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';
import { execFileSync } from 'node:child_process';
import { Store } from '../../src/server/db.js';
import { buildApp } from '../../src/server/app.js';
import { tokenHash } from '../../src/server/security.js';
import { parseTaskSnapshot, readTaskSnapshot, demoTaskSnapshot, taskFreshness, TASK_SNAPSHOT_MAX_BYTES } from '../../src/server/tasks.js';

const reference = new Date('2026-02-05T12:00:00.000Z');
const roots: string[] = [];
const apps: ReturnType<typeof buildApp>[] = [];
const stores: Store[] = [];
const original = { ...process.env };
function live() {
  const snapshot = demoTaskSnapshot(reference);
  snapshot.mode = 'live'; snapshot.tasks = [snapshot.tasks[2]!];
  snapshot.sources = snapshot.sources.filter(source => source.id === snapshot.tasks[0]!.sourceId);
  return snapshot;
}
async function file(value: unknown) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'nexus-audit-task-')); roots.push(root);
  const filename = path.join(root, 'snapshot.json');
  await writeFile(filename, JSON.stringify(value)); return { root, filename };
}
afterEach(async () => {
  await Promise.all(apps.splice(0).map(app => app.close()));
  for (const store of stores.splice(0)) store.db.close();
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true });
  for (const key of ['TASK_DEMO_MODE','TASK_SNAPSHOT_PATH','INTEGRATION_DEMO_MODE','PUBLIC_ORIGIN','NODE_ENV']) {
    if (original[key] === undefined) delete process.env[key]; else process.env[key] = original[key];
  }
});

describe('audit task field whitelist, identity and byte bounds', () => {
  it.each(['command','exec','args','environment','Environment','token','authorization','url','rawLog','logPath','sshKey','metadata'])('forbidden root/source/task field %s is rejected, never silently serialized', key => {
    for (const level of ['snapshot','source','task']) {
      const value = live() as unknown as Record<string, unknown>;
      const target = level === 'snapshot' ? value : level === 'source' ? (value.sources as Record<string, unknown>[])[0]! : (value.tasks as Record<string, unknown>[])[0]!;
      target[key] = 'SYNTHETIC_PRIVATE_SENTINEL';
      expect(() => parseTaskSnapshot(value, reference)).toThrow();
    }
  });
  it.each([
    'Authorization: Bearer SYNTHETIC_SHARED_SECRET',
    'api_key=SYNTHETIC_SHARED_SECRET',
    'Api-Key: SYNTHETIC_SHARED_SECRET',
    'Cookie: session=SYNTHETIC_SHARED_SECRET',
  ])('common embedded credential metadata %s is rejected as unsafe', text => {
    for (const level of ['source','task']) {
      const value = live();
      if (level === 'source') value.sources[0]!.name = text; else value.tasks[0]!.name = text;
      expect(() => parseTaskSnapshot(value, reference)).toThrow();
    }
  });
  it.each([
    ['enabled string', { enabled: 'true' }], ['enabled numeric', { enabled: 1 }],
    ['unknown state', { state: 'healthy' }], ['floating exit', { exitCode: 1.5 }],
    ['huge exit', { exitCode: 65536 }], ['negative duration', { durationMs: -1 }],
    ['unsafe integer duration', { durationMs: Number.MAX_SAFE_INTEGER + 1 }],
    ['numeric ID', { id: 1 }], ['path ID', { id: '../private' }],
    ['blank time zone', { timezone: '' }], ['invented zone', { timezone: 'Synthetic/Private' }],
    ['array schedule', { schedule: ['0 * * * *'] }],
    ['invalid calendar', { observedAt: '2026-02-30T12:00:00Z' }],
    ['timezone-free timestamp', { observedAt: '2026-02-05T12:00:00' }],
    ['non-null unknown next', { nextRunAt: reference.toISOString(), nextRunKind: 'unknown' }],
    ['null authoritative next', { nextRunAt: null, nextRunKind: 'authoritative' }],
  ])('rejects %s rather than coercing task data', (_name, changes) => {
    const value = live(); Object.assign(value.tasks[0]!, changes);
    expect(() => parseTaskSnapshot(value, reference)).toThrow();
  });
  it('exactly 32 unique sources and 1000 linked tasks remain supported', () => {
    const value = live();
    value.sources = Array.from({ length: 32 }, (_, index) => ({ ...value.sources[0]!, id: 'source-' + index }));
    value.tasks = Array.from({ length: 1000 }, (_, index) => ({ ...value.tasks[0]!, id: 'task-' + index, sourceId: 'source-' + index % 32 }));
    const result = parseTaskSnapshot(value, reference);
    expect(result.sources).toHaveLength(32); expect(result.tasks).toHaveLength(1000);
    expect(result.tasks.every(task => task.exitCode === null && task.state === 'unknown')).toBe(true);
  });
  it('33 sources and identity collisions cannot be hidden with a string-key edge case', () => {
    const value = live();
    value.sources = Array.from({ length: 33 }, (_, index) => ({ ...value.sources[0]!, id: 'source-' + index }));
    value.tasks[0]!.sourceId = 'source-0';
    expect(() => parseTaskSnapshot(value, reference)).toThrow();
    const collision = live(); collision.tasks.push({ ...collision.tasks[0]! }); expect(() => parseTaskSnapshot(collision, reference)).toThrow();
  });
  it('special object-property words are ordinary safe string identities, not prototype lookups', () => {
    const value = live(); value.sources[0]!.id = 'constructor'; value.tasks[0]!.sourceId = 'constructor'; value.tasks[0]!.id = 'toString';
    expect(parseTaskSnapshot(value, reference).tasks[0]!.id).toBe('toString');
    value.tasks[0]!.sourceId = 'hasOwnProperty'; expect(() => parseTaskSnapshot(value, reference)).toThrow();
    expect(({} as Record<string, unknown>).syntheticPolluted).toBeUndefined();
  });
  it('exact file-size limit accepts valid padded JSON, +1 byte rejects before parsing', async () => {
    const value = live(); const { filename } = await file(value);
    const json = JSON.stringify(value);
    await writeFile(filename, json + ' '.repeat(TASK_SNAPSHOT_MAX_BYTES - Buffer.byteLength(json)));
    expect((await stat(filename)).size).toBe(TASK_SNAPSHOT_MAX_BYTES);
    expect((await readTaskSnapshot({ path: filename, now: () => reference })).tasks).toHaveLength(1);
    await writeFile(filename, json + ' '.repeat(TASK_SNAPSHOT_MAX_BYTES + 1 - Buffer.byteLength(json)));
    expect((await readTaskSnapshot({ path: filename })).sources[0]!.error).toBe('snapshot_too_large');
  });
  it('UTF8 multibyte file content is bounded by bytes, not JS characters', async () => {
    const { filename } = await file({});
    const text = '文'.repeat(Math.ceil(TASK_SNAPSHOT_MAX_BYTES / 3));
    expect(text.length).toBeLessThan(TASK_SNAPSHOT_MAX_BYTES);
    await writeFile(filename, text);
    expect((await readTaskSnapshot({ path: filename })).sources[0]!.error).toBe('snapshot_too_large');
  });
  it('a FIFO cannot block the web reader while waiting for an external writer', async () => {
    const { root } = await file({}); const fifo = path.join(root, 'fixture-fifo');
    execFileSync('mkfifo', [fifo]);
    const started = Date.now();
    const result = await readTaskSnapshot({ path: fifo });
    expect(Date.now() - started).toBeLessThan(1000); expect(result.sources[0]!.error).toBe('snapshot_invalid');
  });
});

describe('audit task evidence semantics and actual API file boundary', () => {
  it.each([
    [-60001, 'unknown'], [-60000, 'fresh'], [0, 'fresh'], [900000, 'fresh'], [900001, 'stale'],
  ])('age %s milliseconds receives %s at the exact freshness boundary', (age, expected) => {
    expect(taskFreshness(new Date(reference.getTime() - Number(age)).toISOString(), reference)).toBe(expected);
  });
  it('snapshot/source/task use their own observations and never infer job success from transport', () => {
    const value = live();
    value.sources[0]!.observedAt = '2026-02-04T00:00:00Z';
    value.tasks[0]!.observedAt = null; value.tasks[0]!.freshness = 'fresh';
    const result = parseTaskSnapshot(value, reference);
    expect(result.freshness).toBe('fresh'); expect(result.sources[0]!.freshness).toBe('stale');
    expect(result.tasks[0]!.freshness).toBe('unknown'); expect(result.tasks[0]!.state).toBe('unknown'); expect(result.tasks[0]!.exitCode).toBeNull();
  });
  it('real session auth protects invalid snapshot content and reports safe errors to a viewer', async () => {
    const { filename } = await file({ ...live(), token: 'SYNTHETIC_PRIVATE_SENTINEL' });
    process.env.TASK_DEMO_MODE = 'false'; process.env.TASK_SNAPSHOT_PATH = filename; process.env.INTEGRATION_DEMO_MODE = 'true'; process.env.NODE_ENV = 'test'; delete process.env.PUBLIC_ORIGIN;
    const store = new Store(':memory:'); stores.push(store);
    const user = store.createUser('task-audit@example.test', 'unused-hash', 'viewer');
    store.saveSession(tokenHash('synthetic-task-viewer'), user.id, new Date(Date.now() + 60000).toISOString());
    const app = buildApp(store); apps.push(app);
    const anonymous = await app.inject('/api/tasks'); expect(anonymous.statusCode).toBe(401);
    const authenticated = await app.inject({ url: '/api/tasks?path=/etc/passwd&demoMode=true', headers: { cookie: 'nexus_session=synthetic-task-viewer' } });
    expect(authenticated.statusCode).toBe(200); expect(authenticated.json().snapshot.mode).toBe('live');
    expect(authenticated.json().snapshot.sources[0].error).toBe('snapshot_invalid');
    for (const response of [anonymous, authenticated]) { expect(response.body).not.toContain(filename); expect(response.body).not.toContain('SYNTHETIC_PRIVATE_SENTINEL'); }
  });
  it('startup-selected snapshot path cannot be changed via later environment mutation', async () => {
    const { filename } = await file(live()); const invalid = await file({ secret: 'SYNTHETIC_PRIVATE_SENTINEL' });
    process.env.TASK_DEMO_MODE = 'false'; process.env.TASK_SNAPSHOT_PATH = filename; process.env.INTEGRATION_DEMO_MODE = 'true'; process.env.NODE_ENV = 'test'; delete process.env.PUBLIC_ORIGIN;
    const store = new Store(':memory:'); stores.push(store);
    const user = store.createUser('fixed-path@example.test', 'unused-hash', 'viewer');
    store.saveSession(tokenHash('synthetic-fixed-viewer'), user.id, new Date(Date.now() + 60000).toISOString());
    const app = buildApp(store); apps.push(app);
    process.env.TASK_SNAPSHOT_PATH = invalid.filename; process.env.TASK_DEMO_MODE = 'true';
    const response = await app.inject({ url: '/api/tasks', headers: { cookie: 'nexus_session=synthetic-fixed-viewer' } });
    expect(response.json().snapshot.mode).toBe('live'); expect(response.json().snapshot.tasks).toHaveLength(1);
  });
  it('seeded 1000-case mixed invalid-field mutation corpus never silently widens the schema', () => {
    let state = 0x4e585553; const next = () => { state ^= state << 13; state ^= state >>> 17; state ^= state << 5; return state >>> 0; };
    const mutations: Record<string, unknown>[] = [
      { state: 'success' }, { enabled: 'false' }, { durationMs: -2 }, { exitCode: 65536 },
      { timezone: 'Unknown/Audit' }, { nextRunAt: null, nextRunKind: 'estimated' },
      { sourceId: 'undeclared' }, { id: '../unsafe' }, { name: 'password=synthetic' },
      { name: 'https://synthetic.audit.invalid' }, { observedAt: '2026-02-30T00:00:00Z' },
      { unknownField: 'SYNTHETIC_PRIVATE_SENTINEL' },
    ];
    for (let index = 0; index < 1000; index++) {
      const value = live(); const change = mutations[next() % mutations.length]!;
      Object.assign(value.tasks[0]!, change);
      expect(() => parseTaskSnapshot(value, reference), 'seed=0x4e585553 case=' + index).toThrow();
    }
  });
});

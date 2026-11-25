import { afterEach, describe, expect, it } from 'vitest';
import Fastify from 'fastify';
import { mkdtemp, writeFile, rm, symlink, chmod } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { demoTaskSnapshot, parseTaskSnapshot, readTaskSnapshot, registerTaskRoutes, taskFreshness, TASK_SNAPSHOT_MAX_BYTES } from '../../src/server/tasks.js';

const now = new Date('2026-01-15T12:00:00.000Z');
const roots: string[] = [];
async function fixture() {
  const root = await mkdtemp(path.join(tmpdir(), 'nexus-task-fixture-')); roots.push(root);
  const filename = path.join(root, 'snapshot.json');
  const data = { ...demoTaskSnapshot(now), mode: 'live' };
  await writeFile(filename, JSON.stringify(data));
  return { filename, data, root };
}
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

describe('strict read-only snapshot reader', () => {
  it('reads a configured live snapshot and derives freshness independently of supplied classifications', async () => {
    const { filename, data } = await fixture();
    data.freshness = 'stale'; data.tasks[0]!.freshness = 'stale';
    await writeFile(filename, JSON.stringify(data));
    const snapshot = await readTaskSnapshot({ path: filename, now: () => now });
    expect(snapshot.mode).toBe('live'); expect(snapshot.freshness).toBe('fresh');
    expect(snapshot.tasks[0]!.freshness).toBe('fresh');
    expect(snapshot.tasks.at(-1)!.freshness).toBe('stale');
  });
  it('reports empty/missing input as unconfigured, never fallback demo', async () => {
    for (const filename of ['', '/nonexistent-synthetic-task-fixture.json']) {
      const snapshot = await readTaskSnapshot({ path: filename });
      expect(snapshot.mode).toBe('unconfigured'); expect(snapshot.tasks).toEqual([]);
      expect(snapshot.sources[0]!.status).toBe('unavailable'); expect(snapshot.observedAt).toBeNull();
    }
  });
  it('reports invalid JSON safely without raw paths or content', async () => {
    const { filename } = await fixture();
    await writeFile(filename, '{"secret":"sensitive-synthetic-marker"');
    const snapshot = await readTaskSnapshot({ path: filename });
    expect(snapshot.sources[0]!.error).toBe('snapshot_invalid');
    expect(JSON.stringify(snapshot)).not.toContain('sensitive-synthetic-marker');
    expect(JSON.stringify(snapshot)).not.toContain(filename);
  });
  it('bounds files to one MiB and refuses symlinks and directories', async () => {
    const { filename, root } = await fixture();
    await writeFile(filename, ' '.repeat(TASK_SNAPSHOT_MAX_BYTES + 1));
    expect((await readTaskSnapshot({ path: filename })).sources[0]!.error).toBe('snapshot_too_large');
    const link = path.join(root, 'link'); await symlink(filename, link);
    expect((await readTaskSnapshot({ path: link })).tasks).toEqual([]);
    expect((await readTaskSnapshot({ path: root })).sources[0]!.error).toBe('snapshot_invalid');
  });
  it('reports permission denied without exposing filesystem paths', async () => {
    const { filename } = await fixture();
    await chmod(filename, 0);
    try {
      const snapshot = await readTaskSnapshot({ path: filename });
      expect(snapshot.sources[0]!.status).toBe('permission_denied');
      expect(snapshot.sources[0]!.error).toBe('permission_denied');
      expect(JSON.stringify(snapshot)).not.toContain(filename);
    } finally { await chmod(filename, 0o600); }
  });
  it('accepts the standalone Python collector output from pure injected fixtures', () => {
    const code = [
      'import importlib.util,json,datetime',
      "s=importlib.util.spec_from_file_location('fixture_collector','scripts/collect-tasks.py')",
      'm=importlib.util.module_from_spec(s);s.loader.exec_module(m)',
      "runner=lambda args: (0, '11 2 * * * synthetic-job' if args[0].endswith('crontab') else '[]', None)",
      "print(json.dumps(m.collect(runner,datetime.datetime(2026,1,15,12,tzinfo=datetime.timezone.utc),'UTC')))",
    ].join('\n');
    const output = execFileSync('python3', ['-c', code], { encoding: 'utf8', env: { ...process.env, PYTHONDONTWRITEBYTECODE: '1' } });
    const snapshot = parseTaskSnapshot(JSON.parse(output), now);
    expect(snapshot.mode).toBe('live'); expect(snapshot.tasks).toHaveLength(1);
    expect(snapshot.tasks[0]!.state).toBe('unknown'); expect(snapshot.tasks[0]!.nextRunAt).toBeNull();
    expect(snapshot.sources).toHaveLength(3);
  });
  it('rejects unknown fields at root, source and task boundaries', async () => {
    const { data } = await fixture();
    expect(() => parseTaskSnapshot({ ...data, command: 'forbidden' }, now)).toThrow();
    expect(() => parseTaskSnapshot({ ...data, sources: [{ ...data.sources[0], environment: {} }] }, now)).toThrow();
    expect(() => parseTaskSnapshot({ ...data, tasks: [{ ...data.tasks[0], rawLog: 'forbidden' }] }, now)).toThrow();
  });
  it('rejects duplicates, missing source references, unsupported version and forged demo files', async () => {
    const { data } = await fixture();
    for (const value of [
      { ...data, version: 2 }, { ...data, mode: 'demo' },
      { ...data, tasks: [data.tasks[0], data.tasks[0]] },
      { ...data, sources: [data.sources[0], data.sources[0]] },
      { ...data, tasks: [{ ...data.tasks[0], sourceId: 'missing' }] },
    ]) expect(() => parseTaskSnapshot(value, now)).toThrow();
  });
  it('enforces lengths, safe text, timezone, dates and bounded task counts', async () => {
    const { data } = await fixture();
    for (const change of [
      { name: 'x'.repeat(121) }, { name: 'https://private.invalid/sensitive' },
      { name: 'password=synthetic' }, { timezone: 'Invented/Timezone' },
      { observedAt: 'yesterday' }, { durationMs: -1 },
      { nextRunAt: null, nextRunKind: 'authoritative' },
      { lastStartedAt: '2026-01-15T12:00:00Z', lastFinishedAt: '2026-01-14T12:00:00Z' },
    ]) expect(() => parseTaskSnapshot({ ...data, tasks: [{ ...data.tasks[0], ...change }] }, now)).toThrow();
    expect(() => parseTaskSnapshot({ ...data, tasks: Array(1001).fill(data.tasks[0]) }, now)).toThrow();
  });
  it('preserves null history and unknown exit codes, never treats file mtime as success', async () => {
    const { filename, data } = await fixture();
    data.tasks = [{ ...data.tasks[0]!, state: 'unknown', observedAt: null, lastStartedAt: null, lastFinishedAt: null, durationMs: null, exitCode: null }];
    await writeFile(filename, JSON.stringify(data));
    const task = (await readTaskSnapshot({ path: filename, now: () => now })).tasks[0]!;
    expect(task.state).toBe('unknown'); expect(task.freshness).toBe('unknown'); expect(task.exitCode).toBeNull(); expect(task.lastFinishedAt).toBeNull();
  });
  it('creates synthetic fixtures only when explicitly enabled', async () => {
    const snapshot = await readTaskSnapshot({ path: '/missing', demoMode: true, now: () => now });
    expect(snapshot.mode).toBe('demo'); expect(snapshot.tasks.length).toBeGreaterThan(0);
    expect(snapshot.tasks.some(task => task.state === 'failed')).toBe(true);
    expect(snapshot.tasks.some(task => task.state === 'running')).toBe(true);
    expect(snapshot.tasks.some(task => task.enabled === false)).toBe(true);
  });
  it('marks future/invalid/missing observation unknown and old observation stale', () => {
    expect(taskFreshness(null, now)).toBe('unknown');
    expect(taskFreshness('bad', now)).toBe('unknown');
    expect(taskFreshness('2026-01-15T13:00:00Z', now)).toBe('unknown');
    expect(taskFreshness('2026-01-15T11:00:00Z', now)).toBe('stale');
    expect(taskFreshness(now.toISOString(), now)).toBe('fresh');
  });
});

describe('task API exposes read routes only and requires the supplied session guard', () => {
  it('rejects anonymous reads; authenticated readers can list/detail without mutations', async () => {
    const app = Fastify();
    registerTaskRoutes(app, async (request, reply) => {
      if (request.headers.authorization !== 'synthetic-viewer') return reply.code(401).send({ error: 'unauthorized' });
    }, { demoMode: true, now: () => now });
    try {
      expect((await app.inject('/api/tasks')).statusCode).toBe(401);
      const headers = { authorization: 'synthetic-viewer' };
      const response = await app.inject({ url: '/api/tasks', headers });
      expect(response.statusCode).toBe(200); expect(response.headers['cache-control']).toBe('no-store');
      const { snapshot } = response.json(); expect(snapshot.mode).toBe('demo');
      const detail = await app.inject({ url: '/api/tasks/' + snapshot.tasks[0].id, headers });
      expect(detail.json().source.id).toBe(detail.json().task.sourceId);
      expect((await app.inject({ url: '/api/tasks/missing', headers })).statusCode).toBe(404);
      for (const method of ['POST', 'PATCH', 'DELETE'] as const) {
        for (const url of ['/api/tasks', '/api/tasks/demo-backup', '/api/tasks/demo-backup/run']) {
          expect((await app.inject({ method, url, headers })).statusCode).toBe(404);
        }
      }
    } finally { await app.close(); }
  });
  it('captures a fixed reader path at route registration and ignores query path overrides', async () => {
    const { filename } = await fixture(); const app = Fastify();
    registerTaskRoutes(app, async () => {}, { path: filename, now: () => now });
    try {
      const response = await app.inject('/api/tasks?path=/etc/passwd&demoMode=true');
      expect(response.json().snapshot.mode).toBe('live'); expect(response.json().snapshot.tasks.length).toBeGreaterThan(0);
    } finally { await app.close(); }
  });
});

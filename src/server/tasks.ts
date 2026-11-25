import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import type { FastifyInstance, preHandlerHookHandler } from 'fastify';
import { z } from 'zod';
import type { Task, TaskFreshness, TaskSnapshot, TaskSource } from '../shared/tasks.js';

export const TASK_SNAPSHOT_MAX_BYTES = 1024 * 1024;
export const TASK_FRESHNESS_MS = 15 * 60 * 1000;
const safeText = (max: number) => z.string().trim().min(1).max(max).refine(value =>
  !/[\u0000-\u001f\u007f]|https?:\/\/|\b(?:bearer|[\w.-]*(?:token|secret|password|passwd|credential|authorization|cookie)|api[ _-]?key)\b["']?\s*[:=]|\bbearer\s+\S+/i.test(value));
const id = z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:-]{0,119}$/);
const date = z.string().datetime({ offset: true }).transform(value => new Date(value).toISOString()).nullable();
const freshnessSchema = z.enum(['fresh', 'stale', 'unknown']).optional();
const sourceSchema = z.object({
  id, name: safeText(120), kind: z.enum(['cron', 'systemd', 'application', 'snapshot']),
  status: z.enum(['ok', 'unavailable', 'permission_denied', 'error', 'unsupported']),
  completeness: z.enum(['complete', 'partial', 'unknown']), observedAt: date, freshness: freshnessSchema,
  error: z.enum(['not_configured', 'snapshot_missing', 'snapshot_unreadable', 'snapshot_invalid',
    'snapshot_too_large', 'permission_denied', 'command_unavailable', 'query_failed', 'query_timeout', 'unsupported']).optional(),
}).strict();
const taskSchema = z.object({
  id, sourceId: id, name: safeText(120), serviceName: safeText(120).nullable(),
  kind: z.enum(['cron', 'calendar', 'interval', 'event', 'manual', 'unknown']),
  schedule: safeText(200).nullable(),
  timezone: z.string().max(80).refine(value => { try { new Intl.DateTimeFormat('en', { timeZone: value }); return true; } catch { return false; } }).nullable(),
  enabled: z.boolean().nullable(), state: z.enum(['idle', 'running', 'succeeded', 'failed', 'unknown']),
  lastStartedAt: date, lastFinishedAt: date, durationMs: z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).nullable(),
  exitCode: z.number().int().min(-255).max(65535).nullable(), nextRunAt: date,
  nextRunKind: z.enum(['authoritative', 'estimated', 'unknown']), sourceUpdatedAt: date,
  observedAt: date, freshness: freshnessSchema,
}).strict().refine(task => task.nextRunAt !== null || task.nextRunKind === 'unknown')
  .refine(task => task.nextRunKind !== 'unknown' || task.nextRunAt === null)
  .refine(task => !task.lastStartedAt || !task.lastFinishedAt || Date.parse(task.lastFinishedAt) >= Date.parse(task.lastStartedAt));
const snapshotSchema = z.object({
  version: z.literal(1), mode: z.enum(['live', 'demo', 'unconfigured']),
  observedAt: date, freshness: freshnessSchema, sources: z.array(sourceSchema).min(1).max(32), tasks: z.array(taskSchema).max(1000),
}).strict().superRefine((snapshot, ctx) => {
  const sourceIds = new Set(snapshot.sources.map(source => source.id));
  if (sourceIds.size !== snapshot.sources.length || new Set(snapshot.tasks.map(task => task.id)).size !== snapshot.tasks.length ||
      snapshot.tasks.some(task => !sourceIds.has(task.sourceId))) {
    ctx.addIssue({ code: 'custom', message: 'Invalid task/source identity' });
  }
});

export function taskFreshness(observedAt: string | null, now = new Date()): TaskFreshness {
  if (!observedAt) return 'unknown';
  const age = now.getTime() - Date.parse(observedAt);
  return !Number.isFinite(age) || age < -60_000 ? 'unknown' : age <= TASK_FRESHNESS_MS ? 'fresh' : 'stale';
}

export function parseTaskSnapshot(value: unknown, now = new Date()): TaskSnapshot {
  const data = snapshotSchema.parse(value);
  // A file cannot assert demonstration mode or provide trusted freshness classifications.
  if (data.mode !== 'live') throw new Error('snapshot_invalid');
  return { ...data, mode: 'live', freshness: taskFreshness(data.observedAt, now),
    sources: data.sources.map(source => ({ ...source, freshness: taskFreshness(source.observedAt, now) })),
    tasks: data.tasks.map(task => ({ ...task, freshness: taskFreshness(task.observedAt, now) })) };
}

function unavailable(error: NonNullable<TaskSource['error']>, status: TaskSource['status'], unconfigured = false): TaskSnapshot {
  return { version: 1, mode: unconfigured ? 'unconfigured' : 'live', observedAt: null, freshness: 'unknown',
    sources: [{ id: 'snapshot', name: '只读任务快照', kind: 'snapshot', status, completeness: 'unknown',
      observedAt: null, freshness: 'unknown', error }], tasks: [] };
}

export function demoTaskSnapshot(now = new Date()): TaskSnapshot {
  const at = (delta: number) => new Date(now.getTime() + delta).toISOString();
  const source = (id: string, name: string, kind: TaskSource['kind'], observedAt = at(0)): TaskSource =>
    ({ id, name, kind, observedAt, freshness: taskFreshness(observedAt, now), status: 'ok', completeness: 'partial' });
  const sources = [source('demo-system', '示例系统计时器', 'systemd'), source('demo-cron', '示例用户计划', 'cron'),
    source('demo-app', '示例应用调度', 'application'), source('demo-old', '示例过期来源', 'application', at(-7200_000))];
  const task = (id: string, sourceId: string, name: string, state: Task['state'], kind: Task['kind'], schedule: string, changes: Partial<Task> = {}): Task =>
    ({ id, sourceId, name, serviceName: '示例空间', kind, schedule, timezone: 'Asia/Shanghai', enabled: true, state,
      lastStartedAt: at(-3600_000), lastFinishedAt: at(-3540_000), durationMs: 60_000, exitCode: state === 'failed' ? 1 : 0,
      nextRunAt: at(3600_000), nextRunKind: 'estimated', sourceUpdatedAt: null, observedAt: at(0), freshness: 'fresh', ...changes });
  return { version: 1, mode: 'demo', observedAt: at(0), freshness: 'fresh', sources, tasks: [
    task('demo-backup', 'demo-system', '数据库备份', 'succeeded', 'calendar', '每日 02:30'),
    task('demo-images', 'demo-app', '媒体索引更新', 'running', 'interval', '每 30 分钟', { lastStartedAt: at(-120_000), lastFinishedAt: null, durationMs: null, exitCode: null }),
    task('demo-health', 'demo-cron', '服务可用性汇总', 'unknown', 'cron', '*/15 * * * *', { lastStartedAt: null, lastFinishedAt: null, durationMs: null, exitCode: null, nextRunAt: null, nextRunKind: 'unknown' }),
    task('demo-feed', 'demo-app', '订阅内容同步', 'failed', 'interval', '每 6 小时'),
    task('demo-clean', 'demo-system', '临时文件整理', 'idle', 'calendar', '每日 04:00'),
    task('demo-disabled', 'demo-cron', '归档校验', 'unknown', 'cron', '0 3 * * 0', { enabled: false, lastStartedAt: null, lastFinishedAt: null, durationMs: null, exitCode: null, nextRunAt: null, nextRunKind: 'unknown' }),
    task('demo-stale', 'demo-old', '历史来源观察', 'unknown', 'unknown', '由应用决定', { observedAt: at(-7200_000), freshness: 'stale', lastStartedAt: null, lastFinishedAt: null, durationMs: null, exitCode: null, nextRunAt: null, nextRunKind: 'unknown' }),
  ] };
}

export interface TaskSnapshotOptions { path?: string; demoMode?: boolean; now?: () => Date }
export function taskSnapshotOptions(): TaskSnapshotOptions {
  return { path: process.env.TASK_SNAPSHOT_PATH ?? '/data/task-snapshot.json', demoMode: process.env.TASK_DEMO_MODE === 'true' };
}
export async function readTaskSnapshot(options: TaskSnapshotOptions = taskSnapshotOptions()): Promise<TaskSnapshot> {
  const now = options.now?.() ?? new Date();
  if (options.demoMode) return demoTaskSnapshot(now);
  const filename = options.path ?? '/data/task-snapshot.json';
  if (!filename.trim()) return unavailable('not_configured', 'unavailable', true);
  let file;
  try {
    // Only a fixed startup setting is accepted. No request-controlled path or remote URL.
    file = await open(filename, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
    if (!(await file.stat()).isFile()) return unavailable('snapshot_invalid', 'error');
    const bytes = Buffer.alloc(TASK_SNAPSHOT_MAX_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const result = await file.read(bytes, length, bytes.length - length, null);
      if (!result.bytesRead) break;
      length += result.bytesRead;
    }
    if (length > TASK_SNAPSHOT_MAX_BYTES) return unavailable('snapshot_too_large', 'error');
    try { return parseTaskSnapshot(JSON.parse(bytes.subarray(0, length).toString('utf8')), now); }
    catch { return unavailable('snapshot_invalid', 'error'); }
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    return code === 'ENOENT' ? unavailable('snapshot_missing', 'unavailable', true)
      : code === 'EACCES' || code === 'EPERM' ? unavailable('permission_denied', 'permission_denied')
      : unavailable('snapshot_unreadable', 'error');
  } finally { await file?.close(); }
}

/** Explicit auth is required; this module never creates write/execution routes. */
export function registerTaskRoutes(app: FastifyInstance, auth: preHandlerHookHandler, options = taskSnapshotOptions()): void {
  app.get('/api/tasks', { preHandler: auth }, async (_request, reply) => {
    reply.header('Cache-Control', 'no-store');
    return { snapshot: await readTaskSnapshot(options) };
  });
  app.get<{ Params: { id: string } }>('/api/tasks/:id', { preHandler: auth }, async (request, reply) => {
    reply.header('Cache-Control', 'no-store');
    const snapshot = await readTaskSnapshot(options);
    const task = snapshot.tasks.find(item => item.id === request.params.id);
    if (!task) return reply.code(404).send({ error: 'task_not_found' });
    return { task, source: snapshot.sources.find(item => item.id === task.sourceId)! };
  });
}

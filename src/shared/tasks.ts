/** Read-only task-center transport types. No server/runtime dependency. */
export type TaskFreshness = 'fresh' | 'stale' | 'unknown';
export type TaskMode = 'live' | 'demo' | 'unconfigured';
export type TaskKind = 'cron' | 'calendar' | 'interval' | 'event' | 'manual' | 'unknown';
export type TaskState = 'idle' | 'running' | 'succeeded' | 'failed' | 'unknown';
export type TaskSourceKind = 'cron' | 'systemd' | 'application' | 'snapshot';
export type TaskSourceStatus = 'ok' | 'unavailable' | 'permission_denied' | 'error' | 'unsupported';
export type TaskSourceError = 'not_configured' | 'snapshot_missing' | 'snapshot_unreadable' | 'snapshot_invalid' | 'snapshot_too_large' | 'permission_denied' | 'command_unavailable' | 'query_failed' | 'query_timeout' | 'unsupported';
export interface TaskSource {
  id: string; name: string; kind: TaskSourceKind; status: TaskSourceStatus;
  completeness: 'complete' | 'partial' | 'unknown';
  observedAt: string | null; freshness: TaskFreshness; error?: TaskSourceError;
}
export interface Task {
  id: string; sourceId: string; name: string; serviceName: string | null; kind: TaskKind;
  schedule: string | null; timezone: string | null; enabled: boolean | null; state: TaskState;
  lastStartedAt: string | null; lastFinishedAt: string | null; durationMs: number | null;
  exitCode: number | null; nextRunAt: string | null; nextRunKind: 'authoritative' | 'estimated' | 'unknown';
  sourceUpdatedAt: string | null; observedAt: string | null; freshness: TaskFreshness;
}
export interface TaskSnapshot {
  version: 1; mode: TaskMode; observedAt: string | null; freshness: TaskFreshness;
  sources: TaskSource[]; tasks: Task[];
}

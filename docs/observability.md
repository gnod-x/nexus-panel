# Read-only tasks and service integrations

These views summarize evidence; they do not operate services. All endpoints require the existing authenticated session, including viewer access. There are no task execution, task editing, adapter mutation, scan, save, or switch routes.

Defaults are intentionally unconfigured. A missing source is not proof of no jobs, an unsupported upstream is not connected, and a successful fetch is not proof that the underlying data just changed.

## Task snapshots

`TASK_SNAPSHOT_PATH` defaults to `/data/task-snapshot.json`. An empty path or missing file produces `mode: unconfigured`; unreadable, oversized, or invalid configured input produces a safe source error with no tasks. The path is a startup setting, never a request parameter. The reader accepts a regular file without following its final symlink and caps input at 1 MiB.

The version 1 file contains `mode: live`, snapshot `observedAt`, `sources`, and `tasks`; freshness labels may be supplied but are recomputed. The source schema supports cron, systemd, application, and snapshot sources, with complete/partial/unknown coverage. Every task references one declared source. Limits are thirty-two sources and one thousand tasks. Duplicate identities, unsupported fields, malformed dates/timezones, or invalid source references invalidate the snapshot rather than silently accepting untrusted data.

Tasks carry name, optional service name, schedule/kind/timezone, nullable enabled state, evidence state, start/finish timestamps, nullable duration and exit code, next time and its basis, source-update/collection timestamps, and freshness. No command, environment, credential, URL, log path, or payload field is supported. Treat names and schedules as public metadata. Reader/collector reject or sanitize common credential assignments: token/secret/password/passwd/credential/Authorization/Cookie/API-key markers with colon/equal separators, quoted keys and Bearer values, along with URLs/control characters. This is defense in depth, not universal DLP; the publisher must review public metadata.

Collector public text is bounded to 200 characters. A valid long cron expression becomes schedule: null rather than invalidating the entire strict snapshot. Stable task identity still uses the original full schedule and command internally; commands are never emitted.

### Collection and freshness semantics

- `observedAt` is when that snapshot/source/task was collected; it is not necessarily when a job ran.
- `sourceUpdatedAt` is source-provided change time when known, otherwise null.
- Task/source/snapshot freshness uses its own `observedAt`: at most fifteen minutes old is fresh; older is stale. Null collection time or more than one minute in the future is unknown; malformed input dates invalidate the snapshot.
- `lastStartedAt`, `lastFinishedAt`, `durationMs`, and `exitCode` are evidence when available. Null exit code is unknown and never success.
- `nextRunKind: authoritative` means the source supplied that future schedule time; `estimated` must be visibly labeled; `unknown` has no next time. Cron history is not used to guess the next run.
- Unavailable/permission-denied/failed sources retain explicit status and partial/unknown coverage. An empty task list does not establish that all jobs stopped or that every scheduler was inspected.

### Collector

Run `python3 -B scripts/collect-tasks.py` separately on the intended source host. It accepts no arguments and writes only a sanitized snapshot to stdout. It reads the current user's crontab plus system and current-user systemd timers. It does not inspect other users' cron, container schedulers, application queues, or all possible job systems. Cron rows expose schedules and coarse aliases, never commands; cron runtime evidence remains unknown. Timer rows may include source-native next times and safe service result metadata.

The collector uses fixed binaries/arguments, validates systemd unit identifiers, queries with bounded timeouts, and bounds enumeration. Permission errors and missing commands become source errors. Its coverage is always partial. It does not install cron/systemd units, start jobs, edit configuration, or enable periodic collection. Decide and install collection scheduling separately in an authorized host operations task.

For a manually managed snapshot directory, publish with an atomic rename in that directory, after checking collector exit status. Keep the directory writable only by its publisher and readable by the panel's non-root runtime UID; do not make it world-writable. Mount the directory read-only, rather than a single file, so atomic replacement becomes visible inside the container. This example is an operator workflow, not something the web application runs:

```bash
umask 027
python3 -B scripts/collect-tasks.py > /srv/nexus-observe/task-snapshot.next.json &&
mv /srv/nexus-observe/task-snapshot.next.json /srv/nexus-observe/task-snapshot.json
```

Provision directory ownership and read access before running that example. Do not send household snapshots to cloud staging.

## Integration adapters

Configuration is a server-owned version 1 JSON file at `INTEGRATION_CONFIG_PATH`, default `/data/integrations.json`. Missing config or an empty connections list yields unconfigured entries for available adapters. Invalid input is reported as config_invalid; it never falls back to synthetic success. Configuration is limited to 64 KiB and twelve unique connection IDs. See [synthetic example](../examples/integrations.example.json), which uses reserved invalid domains and contains no usable endpoint or secret.

A connection accepts `id`, `name`, `kind`, `baseUrl`, optional `serviceSlug`, and adapter-specific `tokenFile`. HTTP(S) URLs must have no embedded credentials, query, or fragment. An optional base path is preserved before appending the fixed adapter endpoint. serviceSlug links to an existing directory entry; it does not create a service or grant privileges.

### CFSpeed

The adapter reads `GET <baseUrl>/api/results` without credentials; tokenFile is rejected. It requires nonnegative safe-integer total_scanned/total_verified, bounded recommendation arrays, and a boolean scanning value. Only candidate/verified counts, recommendation-array lengths, and scan state are returned. It never starts scanning, verifies a new candidate, switches nodes, or returns recommendation contents.

A valid explicit updated_at with an offset becomes sourceUpdatedAt; otherwise that field is null. Explicit source time more than twenty-four hours old marks the result stale. Missing, invalid, or future source time yields freshness unknown even after a successful fetch; transport success never establishes the age of the upstream result.

### Quark-VOD

The adapter reads `GET <baseUrl>/stats` with an Authorization bearer token from tokenFile. The absolute normalized token path and its real parent directory must remain beneath `/run/secrets/`; mount that file read-only. It must be a regular file without a final symlink, at most 4096 bytes. Whitespace at its edges is trimmed; empty or multiline token values are rejected. Never put the token in JSON, a URL, source control, browser storage, screenshots, or cloud preview config.

Only done, pending, searching, found, saving, failed, and plays nonnegative counters are accepted. UI/API summaries expose saved=done, pending=pending+searching+found+saving, failed, and play-request counts. Play requests are not unique viewers or successful playback. This endpoint supplies no source-update timestamp, so sourceUpdatedAt stays null. The adapter does not read media names, file paths, playback URLs, account cookies, or perform transfer/save operations.

### Polling, errors, and time

Reads occur after authentication and on explicit refresh; there is no background polling scheduler. The backend caches each configured connection, including failures, for thirty seconds and merges concurrent requests. Clicking refresh inside that interval can return the same result. At most three upstream connections run together; every attempt has a four-second deadline covering DNS and response collection and a 512 KiB response limit. Only JSON, uncompressed 2xx bodies are accepted; redirects are not followed.

`checkedAt` is the latest attempted read. `observedAt` is the last successful read; a failed attempt retains that earlier time/metrics when available and marks them stale. `sourceUpdatedAt` is independent and may be unknown. The snapshot's observedAt is response assembly time, not proof every connection was just fetched.

Responses expose config_invalid, permission_denied, unavailable, unsupported_data, timeout, response_too_large, or target_blocked. They do not expose raw network errors, config paths, base URLs, tokens, or upstream bodies. Public adapter catalog availability never means configured, connected, or healthy.

## Deployment boundary

The existing authenticated API and shared SSRF resolver protect these reads. DNS answers are all validated, the connection pins an allowed address, and TLS checks the original hostname. Metadata, loopback, link-local, translated/special ranges, and redirects remain blocked even if a CIDR is configured. Private upstreams require a narrow `HEALTH_ALLOWED_CIDRS`; a URL using 127.0.0.1 inside the panel container cannot be used to bypass that rule.

Use a private Docker network/service address or another approved routable private endpoint. Do not widen trust or expose upstream administration APIs just to make an adapter connect. Mount metadata/config directories and bearer files read-only; retain the existing container hardening. Example override:

```yaml
services:
  nexus-panel:
    environment:
      TASK_SNAPSHOT_PATH: /run/nexus-observe/task-snapshot.json
      INTEGRATION_CONFIG_PATH: /run/nexus-observe/integrations.json
      TASK_DEMO_MODE: "false"
      INTEGRATION_DEMO_MODE: "false"
    volumes:
      - /srv/nexus-observe:/run/nexus-observe:ro
      - /srv/nexus-secrets/quark-vod-token:/run/secrets/quark-vod-token:ro
```

Provision both host paths before deployment, with read access for the non-root image user. Use explicit Compose bind mounts/secrets where appropriate; missing paths must not silently become writable directories. This override is optional and does not install a collector or contact a configured host by itself.

## Synthetic preview

`TASK_DEMO_MODE=true` and `INTEGRATION_DEMO_MODE=true` explicitly select synthetic data instead of their configured real inputs. Both default off, and should be enabled only in the two preview environment. Every relevant page/detail retains a visible demo label. Do not interpret preview counters as household state or use real credentials/URLs there. Disabling flags without supplying valid read-only inputs returns to unconfigured/error behavior.

# API Contract

All endpoints use same-origin `/api/*` paths and JSON. Authentication uses an HTTP-only session cookie. Timestamps are ISO 8601 UTC strings. Errors use `{ "error": "stable_code" }`; validation errors may include a safe `details` object.

## Health and setup

- `GET /api/health` is public and returns `{ status, version, timestamp }`.
- `GET /api/auth/status` is public and returns `{ bootstrapped: boolean }`. When a deployment login alias is configured, it also returns `usernameLoginEnabled: true`; the alias and target account ID are not exposed.
- `POST /api/auth/bootstrap` accepts `{ email, password }` and creates the first admin only. Passwords require at least 12 characters. It returns `{ user }`; later calls return `409 already_bootstrapped`.
- `POST /api/auth/login` accepts `{ email, password }`, sets an HTTP-only, SameSite session cookie, and returns `{ user }`.
- `POST /api/auth/logout` clears the session and returns `{ ok: true }`.
- `GET /api/auth/me` returns `{ user }` for an authenticated session.

## Authentication input

Bootstrap and login trim email edges and map full-width ＠ to @ and ．/。/｡ to . before email validation. Other malformed addresses return 400 invalid_input. Passwords are preserved byte-for-byte as supplied to the existing password hashing/verification path: no trimming, normalization, or truncation. Bootstrap requires 12–200 characters; login accepts 1–200 characters. Normalized email is the stored/looked-up identity.

A deployment may configure LOGIN_USERNAME and LOGIN_USER_ID together to expose one optional login alias for an existing account. Both unset/empty keeps email-only login. The username is 1–64 ASCII letters, digits, underscore, dot or hyphen; the ID must be a canonical positive decimal safe integer. Invalid or incomplete configuration fails startup without logging either value. Login still accepts the existing { email, password } body: the email field may carry the edge-trimmed alias, matched case-sensitively, or a normalized valid email. A matching alias resolves the existing account by ID and verifies its current password hash. Other well-formed usernames, missing target accounts and wrong passwords return 401 invalid_credentials; malformed identity input returns 400 invalid_input. Role, Origin, rate limiting and session rules apply equally to both paths. Bootstrap always requires a valid email and a 12–200-character password. The alias neither provisions users nor renames the stored email; removing both variables and recreating the container restores email-only login. Password changes and session revocation remain separate administrative operations.

## Roles

`admin` can manage, delete, and import records; `operator` can create or edit groups and services and run checks; `viewer` can read dashboard data and open service links. The first version creates the admin through bootstrap; user provisioning and external identity providers are out of scope.

## Overview and events

- `GET /api/overview` returns `{ counts: { total, healthy, degraded, offline, unknown }, averageLatencyMs, checkedAt, recentEvents }`.
- GET /api/events?limit=50 returns { events }. Default 50; nonfinite numeric conversion (including NaN) falls back to 50; finite fractions truncate toward zero, then clamp to 1..200. Thus limit=abc uses 50, limit=3.9 uses 3, limit=-2 uses 1. Available events may be fewer.
- `ServiceEvent` is `{ id, serviceId, type, message, metadata, createdAt }`.

## Groups

`GET /api/groups` returns `{ groups }`.

`POST /api/groups` accepts `{ name, slug, color? }` and returns `{ group }` with status 201. `PATCH /api/groups/:id` accepts any subset of those fields plus `sortOrder`; `DELETE /api/groups/:id` is admin-only and returns `{ ok: true }`.

A group is `{ id, name, slug, color, sortOrder, createdAt }`.

## Services

`GET /api/services` returns `{ services }`.

`POST /api/services` accepts `{ groupId?, name, slug, description?, url, healthUrl?, icon?, tags?, enabled?, sortOrder? }` and returns `{ service }` with status 201. `PATCH /api/services/:id` accepts a subset. `DELETE /api/services/:id` is admin-only and returns `{ ok: true }`.

A service is `{ id, groupId, name, slug, description, url, healthUrl, icon, tags, status, latencyMs, lastCheckedAt, enabled, sortOrder, createdAt, updatedAt }`. Status is `unknown`, `healthy`, `degraded`, or `offline`.

`POST /api/services/:id/check` is available to admin and operator roles. It returns `{ service, result }`, where result contains `{ status, latencyMs, httpStatus?, message }`. Health checks have a bounded timeout and never follow redirects.

Duplicate group and service slugs return `409` with `group_exists` or `service_exists`. `HEALTH_TIMEOUT_MS` controls the health-check timeout and is clamped to 500-15000 milliseconds.

Record IDs on group/service mutation and check routes must be canonical positive decimal safe integers: [1-9] followed by decimal digits, with no leading zero, padding, sign, exponent, hex or fractional spelling. JavaScript-unsafe integers are invalid. Role checks run first: callers without authorization receive 401/403; authorized malformed IDs receive 400 invalid_id. Opaque task identifiers are a separate format. Deleting a valid nonexistent record remains idempotent. Missing non-null groupId on service creation/update returns 400 invalid_group.

## Read-only tasks

All roles with a valid session can read these endpoints. Both return Cache-Control: no-store. No task execution/mutation endpoint exists.

- GET /api/tasks returns { snapshot: TaskSnapshot }.
- GET /api/tasks/:id returns { task, source }, or 404 task_not_found.

TaskSnapshot has version: 1; mode: live | demo | unconfigured; nullable observedAt; freshness: fresh | stale | unknown; sources; and tasks. Sources carry id, name, kind (cron/systemd/application/snapshot), status (ok/unavailable/permission_denied/error/unsupported), completeness (complete/partial/unknown), observedAt, freshness, and an optional safe error code.

Tasks carry id/sourceId/name, nullable serviceName, kind (cron/calendar/interval/event/manual/unknown), nullable schedule/timezone/enabled, state (idle/running/succeeded/failed/unknown), nullable lastStartedAt/lastFinishedAt/durationMs/exitCode/nextRunAt/sourceUpdatedAt/observedAt, nextRunKind (authoritative/estimated/unknown), and freshness. Unknown nextRunKind requires a null next time. Unknown exit code never establishes success.

The server reads the fixed TASK_SNAPSHOT_PATH only, validates a regular file up to 1 MiB, and accepts live version 1 snapshots with at most thirty-two sources and one thousand unique tasks linked to declared sources. Freshness is recalculated per collection timestamp: fifteen-minute threshold, null or more than one minute future is unknown; malformed input dates invalidate the snapshot. Missing input defaults to unconfigured, not a fake empty-success assertion. Configured read/parse failures produce a safe source error and empty tasks, normally with HTTP 200; transport/auth failures remain HTTP errors. This allows the client to show source coverage independently from network failure.

Safe source errors are not_configured, snapshot_missing, snapshot_unreadable, snapshot_invalid, snapshot_too_large, permission_denied, command_unavailable, query_failed, query_timeout, and unsupported. Raw commands, URLs, paths, credentials, and error text are not returned. Coverage can remain partial even for an ok source.

## Read-only service integrations

GET /api/integrations requires an authenticated session for every role, sets Cache-Control: no-store, and returns { snapshot: IntegrationSnapshot }. No request-supplied URL/token/config or generic proxy route is accepted; no mutation endpoint exists.

The version 1 snapshot carries mode (live/demo/unconfigured), observedAt (response assembly time), connections, and an available adapter catalog. Catalog entries include kind, name, summary, and authentication (none/bearer-file). Availability is capability, not connection evidence.

A connection carries id/name/kind, status (connected/unconfigured/error/demo), nullable serviceSlug/observedAt/checkedAt/sourceUpdatedAt, freshness (fresh/stale/unknown), metrics [{ key, label, value, unit? }], and nullable errorCode. observedAt is last successful collection; checkedAt is latest attempt; sourceUpdatedAt is independently supplied upstream time. Failed refreshes can retain prior successful metrics only with stale status evidence. CFSpeed without valid nonfuture source time remains unknown; explicit source time older than twenty-four hours is stale. Quark-VOD exposes query-time counters with sourceUpdatedAt null.

CFSpeed calls fixed GET /api/results without credentials and exposes only candidate/verified counts, recommendation-array lengths, and scan state. Quark-VOD calls fixed GET /stats with server-read bearer-file authentication and exposes saved, combined pending, failed, and play-request counters. No media name, recommendation payload, playback URL, token, config path, or upstream URL is returned.

Per configured connection, successful/error results are cached in memory for thirty seconds and concurrent reads coalesce. Upstream attempts run at most three together, each with a four-second DNS/response deadline and 512 KiB limit. JSON/uncompressed 2xx responses are required; redirects are not followed. The API's no-store response header does not disable this internal bounded collection cache.

Absent config yields unconfigured adapter placeholders. Invalid config/permissions/upstream failures are represented per connection, normally in HTTP 200, with config_invalid, permission_denied, unavailable, unsupported_data, timeout, response_too_large, or target_blocked. A missing upstream response never becomes zero-valued success. Server-only bounded config and read-only secret mounts are described in [observability](observability.md).

TASK_DEMO_MODE and INTEGRATION_DEMO_MODE default false. Explicit true selects visibly labeled synthetic preview data, independently per feature; deployment policy reserves this for two. Demo is not evidence of household connectivity.

## Migration

`POST /api/import/sun-panel` is admin-only and accepts `{ groups: [{ name, slug, color? }], services: [{ groupSlug?, name, slug, description?, url, healthUrl?, icon?, tags? }] }`. The request is limited to **1 MiB of wire JSON body**, including whitespace, 100 groups, and 500 services. Native parser bodyLimit applies before parsed-object validation; reserialization size is not the limit. Every `url` and non-null `healthUrl` is validated before writing. The whole batch runs in one immediate transaction; duplicate slugs or invalid group references roll back all rows. Success returns `{ imported: { groups, services } }` and records an `import` event without URLs or credentials.

## Parser and session failures

Invalid/nonfinite persisted session expiry and expired sessions return 401 unauthorized; revocation and current user role are checked on each request. Parser failures preserve safe client statuses: malformed JSON 400 invalid_json, oversized body 413 payload_too_large, unsupported media type 415 json_required. Unknown routes return 404 not_found without framework route details. Route-level validation retains its documented codes; unexpected failures do not expose raw exception text.

## Security behavior

- Mutating requests require a valid session, role permission, JSON content type, and same-origin `Origin` when supplied. With PUBLIC_ORIGIN set, the normalized HTTP(S) origin must exactly match that configured scheme/host/port; otherwise the incoming Host must match. Invalid PUBLIC_ORIGIN configuration fails startup. Forwarded host headers never expand the allowed origins.
- Login and bootstrap attempts are rate-limited. The bootstrap operation must be atomic so only one first admin can be created.
- Health-check and integration URLs reject credentials, unsupported schemes, metadata destinations, and unsafe DNS answers. DNS validation and connection must use the same resolved address to prevent rebinding. Redirects are not followed.
- Private HTTP targets are needed for self-hosted installations. The deployment can restrict allowed target networks with `HEALTH_ALLOWED_CIDRS`; loopback, link-local, multicast, and special-use ranges are always denied.
- Error responses, event metadata, logs, and frontend telemetry must not include passwords, session tokens, authorization headers, or full target URLs with credentials.

## Homepage font settings

GET /api/settings requires a session and returns { homeFont }. PATCH /api/settings requires the admin role, same-origin JSON, and an exact { homeFont } body. The only accepted IDs are calligraphy, sans, serif, and kai; unknown IDs or extra fields return 400 invalid_input. The selected value is atomically persisted to /data/nexus-settings.json with a versioned shape and owner-only file permissions; an absent file uses calligraphy. Corrupt or unsupported persisted data fails closed rather than applying arbitrary CSS.

Operator and viewer roles may read the current selection, but only an administrator can change it. The API never accepts a CSS declaration, font-family string, URL, or uploaded font asset.

# API Contract

All endpoints use same-origin `/api/*` paths and JSON. Authentication uses an HTTP-only session cookie. Timestamps are ISO 8601 UTC strings. Errors use `{ "error": "stable_code" }`; validation errors may include a safe `details` object.

## Health and setup

- `GET /api/health` is public and returns `{ status, version, timestamp }`.
- `GET /api/auth/status` is public and returns `{ bootstrapped: boolean }`.
- `POST /api/auth/bootstrap` accepts `{ email, password }` and creates the first admin only. Passwords require at least 12 characters. It returns `{ user }`; later calls return `409 already_bootstrapped`.
- `POST /api/auth/login` accepts `{ email, password }`, sets an HTTP-only, SameSite session cookie, and returns `{ user }`.
- `POST /api/auth/logout` clears the session and returns `{ ok: true }`.
- `GET /api/auth/me` returns `{ user }` for an authenticated session.

## Roles

`admin` can manage, delete, and import records; `operator` can create or edit groups and services and run checks; `viewer` can read dashboard data and open service links. The first version creates the admin through bootstrap; user provisioning and external identity providers are out of scope.

## Overview and events

- `GET /api/overview` returns `{ counts: { total, healthy, degraded, offline, unknown }, averageLatencyMs, checkedAt, recentEvents }`.
- `GET /api/events?limit=50` returns `{ events }`; limit is clamped to 1..200.
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

## Migration

`POST /api/import/sun-panel` is admin-only and accepts `{ groups: [{ name, slug, color? }], services: [{ groupSlug?, name, slug, description?, url, healthUrl?, icon?, tags? }] }`. The request is limited to 1 MiB, 100 groups, and 500 services. Every `url` and non-null `healthUrl` is validated before writing. The whole batch runs in one immediate transaction; duplicate slugs or invalid group references roll back all rows. Success returns `{ imported: { groups, services } }` and records an `import` event without URLs or credentials.

## Security behavior

- Mutating requests require a valid session, role permission, JSON content type, and same-origin `Origin` when supplied.
- Login and bootstrap attempts are rate-limited. The bootstrap operation must be atomic so only one first admin can be created.
- Health-check URLs reject credentials, unsupported schemes, metadata destinations, and unsafe DNS answers. DNS validation and connection must use the same resolved address to prevent rebinding. Redirects are not followed.
- Private HTTP targets are needed for self-hosted installations. The deployment can restrict allowed target networks with `HEALTH_ALLOWED_CIDRS`; loopback, link-local, multicast, and special-use ranges are always denied.
- Error responses, event metadata, logs, and frontend telemetry must not include passwords, session tokens, authorization headers, or full target URLs with credentials.

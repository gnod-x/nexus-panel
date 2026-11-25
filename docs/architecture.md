# Architecture

Nexus Panel is a single-instance service workbench. React and TypeScript compile to static assets served by Fastify in the same Node.js 22 process. SQLite (`better-sqlite3`) stores users, hashed sessions, groups, services, and events; schema updates use versioned migrations. The image starts `node dist/server/index.js` and stores persistent state under `/data`.

## Requests and authentication

The browser and `/api/*` share one origin. Random HTTP-only session cookies identify authenticated users; only token hashes are stored. Passwords use scrypt and per-password salts. Bootstrap creates one administrator atomically. Email normalization trims edges and maps common full-width @/dot punctuation; passwords remain unchanged.

Optional paired LOGIN_USERNAME/LOGIN_USER_ID configuration maps one case-sensitive login alias to an existing user ID. It creates no user and changes no database identity. Startup validates both fields; a missing target fails login with the same 401 as wrong credentials. The public auth-status response advertises only whether username entry is enabled. Clients continue sending the identity in the email field; email login remains supported, and bootstrap remains email-only with its original password minimum. Removing both variables and recreating the container disables the alias. See the API contract for accepted formats and normalization.

Writes enforce role, JSON, and Origin checks. Record-ID canonical safe-integer validation follows roles; missing service groups return safe 400, malformed session expiry fails closed, import has a native 1 MiB wire limit, and parser/unknown-route errors retain safe 4xx statuses. See the [API contract](api-contract.md). Origin matches the incoming Host unless exact `PUBLIC_ORIGIN` is configured for a Host-rewriting proxy. Forwarded host headers never expand trust. Invalid public-origin configuration fails startup.

## Browser ownership and route boundary

main.tsx owns authentication, shared service/group/event data, hash navigation, dialogs and management actions. Home.tsx/home.css own the service gallery and embedded schedule section; Tasks.tsx/tasks.css render the read-only schedule both inside the homepage and as a full page in management. AuthScreen and Integrations retain their own component/style pairs.

The website entry is #/. Independent #/manage/services|groups|favorites|tasks|events|integrations|settings routes and #/manage/groups/:id use the management shell. Group management is a dedicated listing with existing role-gated actions. Hash parsing validates numeric group IDs; hashchange/popstate support direct entry and back/forward, while interface navigation writes the matching history entry. Route changes update title/scroll and, after rendering, focus main's heading or main unless an open native dialog must retain focus.

The homepage contains direct service links, separate favorite/detail actions and a bounded, embedded read-only schedule below the service gallery. Favorites sort stably without changing server order. There are no card availability results, counts, inline search/filter controls, management menus, health dashboard or event panels on its homepage. Browser-local favorites sort stably without changing server order. HTTP(S) links use noopener noreferrer and separate detail/favorite hit areas. Check/edit/delete and write dialogs are gated to management as well as their existing roles; a website detail can enter management for that service. Leaving management hides and clears write dialogs, including history navigation. This is UI separation; backend roles, session and origin checks remain authoritative.

Above 900px management has a persistent sidebar. At 900px and below it has a modal drawer with inert main, scroll lock, visible-control focus cycling and Escape/backdrop/selection closing. A breakpoint crossing also closes it. Cleanup restores a connected opener, while navigation that unmounts the opener uses route focus. Website pages have no management drawer. Command search first closes a drawer, avoiding competing focus traps. Shared Dialog keeps native modal/Escape behavior and deferred return to a connected opener without stealing focus from another modal.

Authenticated requests capture a monotonically changing session generation. Activation/logout invalidates previous-session UI work; request counters order repeated directory/task/integration refreshes and health checks. Success, catch and finally handlers check generation/request identity before updating state. Service save/delete and management completion follow this boundary. Guards discard UI completion, not mutations already accepted by the server.

Logout uses a synchronous ref lock, busy/disabled affordances and a post-await generation guard. Failure unlocks retry without clearing the current view. Optional theme/favorite storage failures degrade to in-session state. Directory loading, ready-empty and failure remain separate; failure cannot establish no services/events/jobs.

Task and integration loading stay isolated from the directory. The homepage schedule is rendered below the service gallery and stays independent of directory refreshes. It reads the loaded task snapshot and may refresh that snapshot without reloading services. It does not fetch or run tasks: minute/focus/visibility updates retire elapsed next times and degrade aged snapshot/source/task evidence without promoting server freshness or collecting new data. Existing demo, partial-source, missing/unknown/stale and error semantics stay visible. See [frontend behavior](frontend.md) and [observability](observability.md).

## Health and integration network boundary

Explicit operator/admin health checks validate DNS and connect to the same selected address under one bounded deadline. They read response headers without following redirects. TLS identity is checked against the original hostname.

Read-only integration adapters reuse the same target resolver, including metadata, loopback, link-local, translated-address, multicast, and special-range blocks. Private addresses require an allowed `HEALTH_ALLOWED_CIDRS` network. This setting restricts private targets; it is not a public Internet allowlist.

Only fixed CFSpeed `/api/results` and Quark-VOD `/stats` GET endpoints are used. Their server-side config is bounded to 64 KiB and twelve unique connections. Each upstream attempt has a four-second deadline and 512 KiB body limit. JSON and uncompressed responses are required. Non-2xx responses and redirects are errors. Connections run in batches of at most three.

Per-config connection results, including failures, are cached in memory for thirty seconds; concurrent reads are coalesced. A failed refresh may preserve the prior successful metrics but marks them stale with a separate last-check time. Config URLs, tokens, bodies, and raw errors are never serialized to browsers. There is no generic integration proxy.

## Task snapshot boundary

The API reads a fixed startup-configured local JSON file on request, never a user-supplied path or remote URL. It accepts version 1 live snapshots, limits them to 1 MiB, validates identities and source references, and rejects extra/unrecognized fields. Source, task, and snapshot freshness are recalculated server-side from their own collection timestamps, rather than trusted from file labels.

The separately invoked Python collector reads current-user crontab and system/current-user systemd timer/service metadata using fixed commands. It emits sanitized JSON to stdout. It does not install a scheduler, modify cron/systemd, read logs or environment files, open service URLs, or run discovered commands. Coverage remains partial even after successful collection. The web container never needs host systemd access, a Docker socket, or SSH credentials.

Task data remains an external snapshot; no scheduler, execution history database, or task control API is added. Source-native next execution times are labeled authoritative; missing times remain unknown. See [observability](observability.md) for exact semantics and safe deployment.

## Deployment and staging

The unprivileged container uses a read-only root filesystem, dropped capabilities, no-new-privileges, bounded CPU/memory/PIDs, a persistent data volume, and small tmpfs. Default host binding is loopback. Optional metadata/config and secrets must be mounted read-only with least-privilege access.

Both observability features default to unconfigured when their input is missing. Demo flags require explicit `true` and are reserved for visibly synthetic fixtures, including the separate cloud preview on two. The 0.2.0 release supports an explicitly authorized local build and deployment while retaining the original Compose project, data volume, resource limits and read-only mounts. Household URLs, tokens, production databases and host task payloads do not belong in the cloud preview, source fixtures or release bundle. Deployment and rollback details are maintained in the [deployment guide](deployment.md).

## Homepage typography configuration

The management settings page exposes four fixed homepage font presets. The admin-only PATCH /api/settings validates a shared enum and atomically persists a versioned setting at /data/nexus-settings.json, separate from the SQLite account database. This keeps the preference inside the existing writable /data volume without a database migration. The selected CSS family is scoped to .nexus-home, so management/authentication typography and task descriptions, schedules, and timestamps retain their existing families.

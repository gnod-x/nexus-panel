# Nexus Panel project contract

Nexus Panel is a single-instance self-hosted service workbench: personal launcher, explicit availability checks and configured read-only task/integration evidence. It does not manage containers or execute jobs.

## Architecture and ownership

- Supported stack: Node.js 22, TypeScript, React, Vite, Fastify, SQLite/better-sqlite3.
- One unprivileged image serves static UI and same-origin API on port 3000. Entry: dist/server/index.js. Versioned migrations own persistent /data users, hashed sessions, groups, services and events.
- main.tsx owns auth/session generation, shared data, hash navigation and management; Home/AuthScreen/Tasks/Integrations own their interfaces. Shared Dialog owns native modal/focus restoration; styles.css owns separate website/management shells.
- Authoritative details: [API](docs/api-contract.md), [architecture](docs/architecture.md), [frontend](docs/frontend.md), [observability](docs/observability.md), [migration](docs/migration.md), [deployment](docs/deployment.md), [testing](docs/testing.md).

## Product boundaries

- Services/groups/search/favorites/import/events/auth are supported. Admin/operator/viewer permissions remain server-enforced. Atomic first-admin bootstrap exists; user provisioning and OIDC are outside this release.
- Website route #/ presents a navbar-free service gallery with a visually hidden 工作台 heading, a top-right 管理 entry, separate link/favorite/detail controls, and embedded read-only 定时任务 cards below the service tiles. The full filterable task center is #/manage/tasks; other management routes remain under #/manage/*. Homepage cards show no availability status/counts or management menu. Home typography supports four fixed, server-owned presets; settings alter homepage service names and its embedded task heading only.
- Tasks summarize sanitized current-user cron and system/current-user timer metadata. Coverage remains partial; unknown exit codes, stale/missing evidence never prove success or absence.
- Fixed CFSpeed GET /api/results and Quark-VOD GET /stats adapters are read-only. No task run/edit, scan/save/switch or generic proxy exists. Secrets stay server-side.
- Missing config is unconfigured, never fake success. Demo defaults false and is reserved for visibly synthetic two preview data.
- No Docker socket, SSH key, household endpoint/token/snapshot or production database belongs in cloud fixtures/source.

## Security and frontend contracts

- Session authentication protects task/integration reads including viewers. Writes require role, JSON and same-origin rules. Exact PUBLIC_ORIGIN handles Host rewriting; forwarded hosts never expand trust.
- Invalid/nonfinite session expiry fails 401. Mutation/check record IDs are canonical positive decimal safe integers, checked after roles. Missing service group is 400. Import is one transaction bounded by native 1 MiB wire JSON, 100 groups/500 services.
- Health/adapters validate all DNS answers and pin allowed targets. Metadata/special ranges/redirects stay blocked; HEALTH_ALLOWED_CIDRS narrows private targets. Browser responses/events omit raw credentials/upstream bodies/errors.
- Email normalization is documented and limited; passwords remain exact. Optional paired LOGIN_USERNAME/LOGIN_USER_ID maps a validated deployment alias to an existing account, never provisioning or renaming it. Default login and bootstrap stay email-only; bootstrap keeps its 12-character minimum. Preserve password managers, paste, inline validation/error focus and duplicate-submit locks.
- Async completions must respect captured session generation and applicable request order. Logout requires a synchronous duplicate-request lock and retry unlock; optional browser storage failures degrade safely to session-only preferences. Loading/failure must never imply known-empty data.
- Homepage display typography is configurable by admins in the management settings page using four fixed presets. The authenticated API stores the enum atomically under /data/nexus-settings.json; CSS is scoped to the homepage only, and arbitrary CSS/font URLs are never accepted.
- Independent #/manage/services|groups|favorites|events|integrations|settings and #/manage/groups/:id routes retain server-enforced roles; group management has its own listing. Management uses a persistent sidebar above 900px and a focus-cycling, inert-background drawer at <=900px; breakpoint changes close it. Hash back/forward preserves route behavior and moves focus to the new heading/main unless a dialog owns focus. Leaving management hides and clears write dialogs; website details can enter management for write actions. Shared native Dialog restores connected opener focus. Dark/light, visible focus, reduced motion, 44px principal controls, 12px auxiliary/16px editable input text, long text, 320px and enlarged text are gates.
- Collector public metadata rejects recognized credential assignments; long valid cron schedule becomes null without changing stable identity. This is not universal DLP.
- Migration source remains read-only. Encoded SQLite URI, source/sidecar output-alias protection and omission of whole sensitive descriptions are required. Manual review remains mandatory; private exports are not backups.

## Development and release

The synthetic cloud preview stays at two:/data/workspace/nexus-panel and retains its own project, account and volume. On 2026-11-25 the user explicitly authorized a v0.2.0 release and deployment on the home host, including local validation and the minimum repairs required for acceptance. Use synthetic fixtures for tests; preserve the household deployment project/data/mounts and never copy household endpoints, tokens, snapshots or databases into cloud fixtures or release assets.

Preserve nexus-ui-preview project/origin/account/volume. The 2026-11-25 cloud preview is nexus-panel:home-fonts-20261125 (ID sha256:081196703de176303b23ed6cef16648995ac5b04d729106583e72361b6182b8a), on project nexus-ui-preview, logical nexus_data volume, loopback 127.0.0.1:18085 and the unchanged public origin. It adds admin-configurable 柳体/黑体/宋体/楷体 homepage typography through /api/settings; the existing account, three groups, nine synthetic services and event remain intact, and the persisted selection defaults to 柳体. The previous nexus-panel:silver-20261124 image and consistent pre-release environment/data backup are retained; details are in docs/deployment.md and artifacts/home-font-settings/release-20261125/. The home host remains on its separate 8085 deployment.

Run typecheck, unit/API, Python, production build, isolated baseline Chromium and independent Chromium/Firefox audit suites, then final container smoke/backup-restore. Record actual counts/times/limits; never infer soak/deployment from source checks. Rewrite corresponding docs after behavior changes. Remove own temporary files/caches while keeping runtime and explicitly retained rollback/evidence.

# Frontend behavior

The signed-in entry (#/) is a service workbench. It keeps a visually hidden 工作台 heading, a 管理 entry at the upper right, service tiles with independent open/favorite/detail controls, and a read-only 定时任务 section below the gallery. The homepage has no inline service search, filter tabs, per-service availability status, service counts, or management menus. The full task center is under #/manage/tasks; service search and CRUD remain in management and the global Ctrl/Cmd+K command palette.

## Route and interaction ownership

main.tsx owns authentication, hash routing, session-safe directory/task/integration data and management actions. Home.tsx renders the gallery and embeds Tasks with the existing task snapshot; the homepage does not run jobs or install a scheduler. Tasks also renders the full task center in management. Integrations and AuthScreen own their respective views. Shared website and management tokens live in styles.css; the gallery layout lives in home.css.

The website entry is #/. Management routes include #/manage/services, #/manage/groups, #/manage/favorites, #/manage/tasks, #/manage/events, #/manage/integrations, #/manage/settings and #/manage/groups/:id. Management uses a persistent sidebar above 900px and a focus-contained drawer at smaller widths. Hash back/forward, direct entry, route focus, dialogs and role-gated writes retain their documented behavior.

## Homepage gallery and schedule

Service tiles use a responsive asymmetric grid. Each card has a distinct service link, favorite button and details button; unsafe URL schemes do not become links. Favorites sort stably ahead of other services without changing server order. Directory loading, failed reads and successful empty results remain distinct. A failed refresh keeps the prior gallery visible.

The embedded task section appears below the service tiles. It is read-only, consumes the current snapshot, can refresh independently, and preserves live/demo/unconfigured, source freshness, unknown timing, and stale evidence semantics. Task descriptions, schedules and timestamps use their existing typography.

## Homepage font preference

Management settings let administrators preview and save four fixed homepage fonts: 柳体、黑体、宋体和楷体. The server-owned selection applies to homepage service titles and the embedded task heading. It is shared across sessions. The admin-only API accepts the fixed enum, not CSS declarations, font-family strings, URLs or uploaded assets. Settings are stored atomically in /data/nexus-settings.json; a missing file defaults to 柳体. The font CSS variable is scoped to .nexus-home, so management, authentication and task body/data text are unchanged. Non-calligraphy presets use local system font stacks and make no remote font requests. The selector remains 16px with a 44px minimum target and stacks on narrow screens.

## Visual, accessibility and evidence gates

The current interface uses the Monochrome Silver dark/light tokens and the bundled self-hosted Liu Jian Mao Cao calligraphy display face. Preserve visible keyboard focus, reduced-motion behavior, readable long labels, 320px layouts, 200% text, 44px principal controls, and 16px editable fields. Homepage font coverage includes all option labels, admin preview/save, viewer read-only behavior, selection persistence, homepage scope, desktop/mobile rendering, and no overflow.

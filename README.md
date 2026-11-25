# Nexus Panel

Nexus Panel is a self-hosted personal portal for service cards and read-only scheduled-task information. It runs as one Docker container and stores its data in a persistent SQLite database.

## Run with Docker

Download a verified Docker bundle from GitHub Releases, or build from a source checkout. The [deployment guide](docs/deployment.md) covers both paths, local access, upgrading with a persistent data volume, and backup and recovery.

The panel listens on <http://127.0.0.1:18085> by default. The first visit creates a local administrator. The homepage contains service links, favorites and a read-only task schedule below the service gallery. The separate management area provides service/group search and editing, explicit availability checks, the complete task center, integrations and events. Administrators can choose one of four homepage font presets in management settings. The web interface is in Simplified Chinese.

Version 0.2.0 includes the separate website and management interfaces, read-only task/integration evidence, homepage font settings and additional authentication/network hardening. See the [release notes](docs/releases/v0.2.0.md).

## Local development

Use Node.js 22 and npm:

```bash
npm ci
npm run dev
```

The Vite app runs at `http://localhost:5173` and proxies `/api` to port 3000. In a second terminal run `npm run dev:server`. `npm run check` runs type checks, unit tests, and a production build.

## Health check policy

Health checks request configured HTTP or HTTPS endpoints with a short timeout and do not follow redirects. Self-hosted installations often monitor private LAN addresses; `HEALTH_ALLOWED_CIDRS` controls the private ranges the app may contact. Cloud metadata, loopback, link-local, multicast, and special-use addresses are always denied. Treat the panel as a privileged network client and restrict who can add targets.

## Importing Sun-Panel data

The migration utility opens a Sun-Panel SQLite database in read-only mode and exports group names, service names, descriptions, and HTTP(S) links. Review the private JSON locally before uploading it through the administrator's import dialog. See the [migration guide](docs/migration.md) for the commands and supported fields.

## Documentation

- [API and role contract](docs/api-contract.md)
- [Architecture](docs/architecture.md)
- [Frontend behavior](docs/frontend.md)
- [Read-only task and integration configuration](docs/observability.md)
- [Homepage font settings](docs/homepage-fonts.md)
- [Testing and release checks](docs/testing.md)
- [Security reporting](SECURITY.md)

## License

Apache-2.0. See `LICENSE`. The bundled Liu Jian Mao Cao font uses SIL OFL 1.1; see [third-party notices](THIRD_PARTY_NOTICES.md).

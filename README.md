# Nexus Panel

Nexus Panel is a self-hosted control center for service links, availability checks, and recent incidents. It runs as one Docker container and stores its data in a persistent SQLite database.

## Run with Docker

Download a verified Docker bundle from GitHub Releases, or build from a source checkout. The [deployment guide](docs/deployment.md) covers both paths, local access, upgrading with a persistent data volume, and backup and recovery.

The panel listens on <http://127.0.0.1:18085> by default. The first visit creates a local administrator. From the dashboard, group and search service links, bookmark favorites, run a health check on demand, and view recent events. The web interface is in Simplified Chinese.

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
- [Security reporting](SECURITY.md)

## License

Apache-2.0. See `LICENSE`.

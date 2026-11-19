# Architecture

Nexus Panel is a single-instance application. A React and TypeScript client is built to static assets and served by the Fastify API process. SQLite (`better-sqlite3`) stores users, sessions, service groups, service entries, and events. Schema updates are tracked by a versioned migration runner. The Docker image contains the complete application; a named volume at `/data` contains persistent state.

## Request path

The browser and `/api/*` share the same origin. Authentication uses a random, HTTP-only session cookie; only a hash of the session token is stored. Passwords use Node's scrypt implementation with per-password salts. Bootstrap creates one administrator atomically and then closes permanently unless the database is reset deliberately.

## Health checks

Checks are initiated by an authenticated operator or administrator. DNS and the request share one deadline (`HEALTH_TIMEOUT_MS`, clamped to 500-15000 ms). The client reads only the response headers and does not follow redirects. Connections use a validated address from DNS, and TLS certificates are checked against the configured hostname. Metadata, loopback, link-local, multicast, and special-use endpoints are blocked; private networks can be allowed explicitly for monitoring.

## Deployment boundary

The container runs as an unprivileged user with a read-only root filesystem, dropped Linux capabilities, no-new-privileges, bounded memory/CPU/PIDs, a writable data volume, and a small temporary filesystem. It does not mount the Docker socket. The default Compose binding is loopback. See [deployment](deployment.md) for HTTPS access and volume backups.

## Staging data

Cloud verification uses synthetic groups, services, and URLs. No home service addresses, credentials, imported database, or uploaded icons are sent to staging. Production migration runs locally and writes to a separate Nexus database.

# Deploy Nexus Panel

Nexus Panel 0.2.0 runs as one unprivileged Node.js 22 container. Docker Engine and the Docker Compose v2 plugin are required. Persistent application data belongs in `/data`; the default published address is `127.0.0.1:18085`.

## Install the release bundle

Download the archive matching the host architecture and its checksum from GitHub Releases. `x86_64` uses `linux-amd64`. From the directory containing both files:

```bash
sha256sum -c nexus-panel-v0.2.0-linux-amd64.tar.gz.sha256
tar -xzf nexus-panel-v0.2.0-linux-amd64.tar.gz
cd nexus-panel-v0.2.0-linux-amd64
docker load -i nexus-panel-image.tar
cp .env.example .env
docker compose -p nexus-panel up -d --no-build --pull never
```

Open <http://127.0.0.1:18085> and create the first administrator. A remote administrator can forward the loopback port with `ssh -N -L 18085:127.0.0.1:18085 USER@SERVER`. Ongoing remote access should use an authenticated private network or identity-aware HTTPS proxy. Production session cookies require HTTPS apart from loopback.

The bundle includes the image, Compose configuration, example environment, complete documentation, read-only collector and third-party licenses. No household database, credentials or private integration configuration belongs in a release bundle.

## Upgrade an existing installation

Keep the original Compose project name, data volume and deployment-specific override files. Load the new image, take a consistent private backup, then change `NEXUS_IMAGE` in the existing deployment environment to `nexus-panel:0.2.0`. Recreate the same service using its original Compose command and overrides with `up -d --no-build --pull never`.

Do not replace an existing `.env` with `.env.example`. Preserve the binding/port, public origin, login alias, allowlisted private targets, resource limits and read-only metadata/config/secret mounts. Do not run `down -v` against an existing installation. A different Compose project would select a different default data volume.

Version 0.2.0 retains database schema 1. Existing users, password hashes, sessions, groups, services and events remain in SQLite. The homepage font preference is stored separately at `/data/nexus-settings.json`; a missing file defaults to 柳体. See [homepage font settings](homepage-fonts.md).

After rollout, check Docker health, `GET /api/health` (`status: ok`, `version: 0.2.0`), the homepage and its current JS/CSS/font assets. Anonymous reads of services/tasks/integrations/settings should return 401. Verify authenticated data and actual read-only task/integration inputs separately; a healthy process does not prove external services or jobs succeeded.

## Binding and proxy origin

`NEXUS_PORT` changes the host port. Keep `NEXUS_BIND_ADDRESS=127.0.0.1` unless the proxy requires another interface, and deliberately restrict any broader binding. Narrow `HEALTH_ALLOWED_CIDRS` to required private targets; this setting does not restrict all public Internet egress.

Write requests normally require the browser origin to match the incoming Host. If an HTTPS proxy rewrites Host, configure an exact `PUBLIC_ORIGIN`, such as `https://panel.example.com`. Include the scheme and any nondefault port, with no path, query, fragment or credentials. Arbitrary forwarded hosts never expand trust. Invalid configuration prevents startup. Recreate the container after environment changes.

## Existing-account login alias

Optional paired `LOGIN_USERNAME` and `LOGIN_USER_ID` map one case-sensitive ASCII username to an existing positive safe-integer account ID. They create no account and do not rename it. Email login and the current password/role remain valid. The alias accepts 1–64 letters, digits, underscore, dot or hyphen; incomplete/invalid configuration fails startup, and a missing target fails authentication.

Auth status advertises only whether alias login is enabled. Bootstrap remains email-only with its 12-character password minimum. Remove both variables and recreate the service to disable the alias. Password changes and session revocation are separate operations.

## Read-only task and integration inputs

Keep `TASK_DEMO_MODE=false` and `INTEGRATION_DEMO_MODE=false` on real installations. Missing inputs display unconfigured/unknown states. Explicit demo mode is only for visibly synthetic fixtures.

`TASK_SNAPSHOT_PATH` defaults to `/data/task-snapshot.json`. The separately invoked `scripts/collect-tasks.py` reads sanitized current-user cron and system/current-user timer metadata and emits version 1 JSON to stdout. It does not install schedules, run discovered commands or collect complete execution history. If a host collector atomically replaces snapshots, mount its directory read-only so replacements remain visible. The web container needs no Docker socket, SSH key or host systemd access.

`INTEGRATION_CONFIG_PATH` defaults to `/data/integrations.json`. Its version 1 configuration contains at most twelve connections. Only fixed CFSpeed `GET /api/results` and Quark-VOD `GET /stats` adapters exist. Quark-VOD credentials come from a read-only absolute `/run/secrets/...` file, never source, JSON URLs, environment examples or screenshots. Mount only required metadata/config paths and the secret file with non-root read permissions. See `examples/integrations.example.json` for synthetic configuration.

Adapters validate DNS answers, pin allowed targets and block loopback, metadata, link-local, translated/special ranges and redirects. Attempts have four-second deadlines and 512 KiB response limits; at most three run together. Reads coalesce/cache for thirty seconds. Refresh does not run a scan or bypass that cache. See [observability](observability.md) and the [API contract](api-contract.md) for schemas and evidence semantics.

## Consistent backup and recovery

Backups contain private accounts, sessions and links. This example assumes project `nexus-panel` and volume `nexus-panel_nexus_data`. Use the actual deployment's Compose command and override files when stopping or starting it. Stop the application for a whole-volume backup so SQLite and its companion files are consistent:

```bash
umask 077
mkdir -p backups
backup="backups/nexus-data-$(date -u +%Y%m%dT%H%M%SZ).tgz"
docker compose -p nexus-panel stop
docker run --rm --network none --user 0:0 \
  -v nexus-panel_nexus_data:/data:ro nexus-panel:0.2.0 \
  tar -czf - -C /data . > "$backup"
docker compose -p nexus-panel start
sha256sum "$backup" > "$backup.sha256"
```

Retain the previous image and private deployment environment. To roll back only the application, restore the previous `NEXUS_IMAGE` and recreate the original service with the same project/volume/overrides. Older images ignore the added font preference file.

Test data recovery in a different Compose project and empty volume on an unused loopback port. For example, `NEXUS_PORT=18086 docker compose -p nexus-recovery create --no-build --pull never` creates `nexus-recovery_nexus_data`; restore the archive using a network-disabled helper container, then start that recovery project. Verify login, directory contents, settings and integrity before deliberately replacing live data. Never restore an old database over newer changes merely to change an application image.

## Source builds and release verification

Build a reviewed checkout with `docker build --build-arg APP_VERSION=0.2.0 -t nexus-panel:0.2.0 .`. Alternatively use `docker compose -p nexus-panel -f docker-compose.yml -f compose.build.yml up -d --build`, preserving the installation's environment and overrides. Source installs require the same backup and verification steps.

The tag-triggered workflow validates package/tag versions, runs static/API/Python/Chromium checks, builds the image, tests clean install/restart/backup restore, packages it and creates GitHub Release assets. Exact browser/runtime verification is described in [testing](testing.md); changes are listed in the [v0.2.0 notes](releases/v0.2.0.md).

## Separate synthetic cloud preview

The previously recorded 2026-11-25 preview on `two` uses project `nexus-ui-preview`, its own data volume, the `home-fonts-20261125` image and loopback 18085 behind its configured public origin. Its accounts and synthetic fixtures are separate from a household installation. A local release must not replace that account/volume or transfer household databases, snapshots, endpoints or credentials to it.

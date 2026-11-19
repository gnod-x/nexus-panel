# Deploy Nexus Panel

Use Docker Engine and the Docker Compose v2 plugin or newer. Select a release bundle matching your host architecture (`x86_64` corresponds to `linux-amd64`).

Download the bundle and its checksum from GitHub Releases. From the directory containing both files:

```bash
sha256sum -c nexus-panel-v0.1.0-linux-amd64.tar.gz.sha256
tar -xzf nexus-panel-v0.1.0-linux-amd64.tar.gz
cd nexus-panel-v0.1.0-linux-amd64
docker load -i nexus-panel-image.tar
cp .env.example .env
docker compose -p nexus-panel up -d --no-build --pull never
```

Open <http://127.0.0.1:18085> on the Docker host and create the first administrator. A remote administrator can forward the loopback port with `ssh -N -L 18085:127.0.0.1:18085 USER@SERVER` and open the same address in their browser. For ongoing remote use, put the panel behind an authenticated private network or identity-aware proxy with HTTPS and preserve the browser's `Host` header. Production session cookies require HTTPS apart from loopback.

`NEXUS_PORT` changes the host port. Leave `NEXUS_BIND_ADDRESS` at `127.0.0.1` unless the proxy cannot reach loopback; then restrict access to the chosen interface. Narrow `HEALTH_ALLOWED_CIDRS` to the private networks that contain your configured services.

## Build from source

From a tagged source checkout, use the same project name to retain the same data volume:

```bash
cp .env.example .env
docker compose -p nexus-panel -f docker-compose.yml -f compose.build.yml up -d --build
```

## Backup and recovery

The commands below assume the project name `nexus-panel`, which creates the volume `nexus-panel_nexus_data`. Keep the archive private; it contains accounts, sessions, and links. Stop the application while taking the backup so the database and its companion files are copied together. Use a new filename for each backup.

```bash
umask 077
mkdir -p backups
backup="backups/nexus-data-$(date -u +%Y%m%dT%H%M%SZ).tgz"
docker compose -p nexus-panel stop
docker run --rm --network none --user 0:0 \
  -v nexus-panel_nexus_data:/data:ro nexus-panel:0.1.0 \
  tar -czf - -C /data . > "$backup"
docker compose -p nexus-panel start
```

Recover into a separate Compose project and an empty volume. The following uses host port 18086. Keep the same `NEXUS_PORT` value on subsequent commands when using the recovery project.

```bash
NEXUS_PORT=18086 docker compose -p nexus-recovery create --no-build --pull never
docker run --rm -i --network none --user 0:0 \
  -v nexus-recovery_nexus_data:/data nexus-panel:0.1.0 \
  tar -xzf - -C /data < "$backup"
NEXUS_PORT=18086 docker compose -p nexus-recovery start
```

Verify that the admin can log in and the service directory is intact at <http://127.0.0.1:18086>. Leave the original volume in place until you have verified the recovery.

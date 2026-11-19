#!/usr/bin/env bash
set -euo pipefail

image=${1:?Usage: bash scripts/compose-smoke.sh IMAGE}
root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
work=$(mktemp -d)
primary="nexus-smoke-$$"
restored="${primary}-restore"
target="${primary}-target"
export NEXUS_IMAGE="$image" NEXUS_BIND_ADDRESS=127.0.0.1 NEXUS_PORT=0
export HEALTH_ALLOWED_CIDRS=10.0.0.0/8,172.16.0.0/12,192.168.0.0/16

compose() {
  local project=$1
  shift
  docker compose --env-file /dev/null -f "$root/docker-compose.yml" -p "$project" "$@"
}

cleanup() {
  local status=$?
  trap - EXIT
  if (( status != 0 )); then
    compose "$primary" logs --tail=20 >&2 || true
    compose "$restored" logs --tail=20 >&2 || true
  fi
  docker rm -f "$target" >/dev/null 2>&1 || true
  compose "$restored" down -v >/dev/null || status=1
  compose "$primary" down -v >/dev/null || status=1
  rm -rf -- "$work"
  exit "$status"
}
trap cleanup EXIT

ready() {
  local address
  address="http://$(compose "$1" port nexus-panel 3000)"
  [[ $address == http://127.0.0.1:* ]]
  for _ in {1..40}; do
    if curl -fsS --max-time 1 -o /dev/null "$address/api/health" 2>/dev/null; then
      printf '%s\n' "$address"
      return
    fi
    sleep 0.5
  done
  printf '%s did not become ready\n' "$1" >&2
  return 1
}

json_post() {
  curl -fsS --max-time 20 -H 'Content-Type: application/json' "$@"
}

# Only the disposable staging instance uses these fixture credentials.
login='{"email":"smoke@example.test","password":"disposable smoke test password"}'
compose "$primary" up -d --no-build --pull never
base=$(ready "$primary")
mime=$(curl -fsS --max-time 5 -o /dev/null -w '%{content_type}' "$base/")
[[ $mime == 'text/html; charset=utf-8' ]]
[[ $(curl -sS --max-time 5 -o /dev/null -w '%{http_code}' "$base/api/services") == 401 ]]
json_post -d "$login" "$base/api/auth/bootstrap" >/dev/null
json_post -c "$work/session" -d "$login" "$base/api/auth/login" >/dev/null
json_post -b "$work/session" -d '{"name":"Smoke group","slug":"smoke-group"}' "$base/api/groups" >/dev/null

docker run --rm -d --name "$target" --network "${primary}_default" "$image" \
  node -e 'require("node:http").createServer((_, res) => res.writeHead(204).end()).listen(3000, "0.0.0.0")' >/dev/null
for _ in {1..20}; do
  if docker exec "$target" node -e 'fetch("http://127.0.0.1:3000/").then(r => { if (r.status !== 204) process.exit(1); }).catch(() => process.exit(1));'; then
    break
  fi
  sleep 0.25
done
service=$(json_post -b "$work/session" -d "{\"name\":\"Smoke service\",\"slug\":\"smoke-service\",\"groupId\":1,\"url\":\"http://$target:3000/\"}" "$base/api/services")
id=$(printf '%s' "$service" | python3 -c 'import json, sys; print(json.load(sys.stdin)["service"]["id"])')
json_post -b "$work/session" -d '{}' "$base/api/services/$id/check" |
  python3 -c 'import json, sys; r = json.load(sys.stdin)["result"]; assert r["status"] == "healthy" and r["httpStatus"] == 204, r'

verify_directory() {
  curl -fsS --max-time 5 -b "$work/session" "$1/api/services" |
    python3 -c 'import json, sys; (s,) = json.load(sys.stdin)["services"]; assert s["slug"] == "smoke-service" and s["groupId"] == 1 and s["status"] == "healthy"'
  curl -fsS --max-time 5 -b "$work/session" "$1/api/groups" |
    python3 -c 'import json, sys; (g,) = json.load(sys.stdin)["groups"]; assert g["slug"] == "smoke-group"'
  curl -fsS --max-time 5 -b "$work/session" "$1/api/events" |
    python3 -c 'import json, sys; (e,) = json.load(sys.stdin)["events"]; assert e["type"] == "health_check"'
}

compose "$primary" restart -t 5
base=$(ready "$primary")
verify_directory "$base"
printf 'Clean install, login, health check and restart passed.\n'

compose "$primary" stop -t 5
docker run --rm --network none --user 0:0 -v "${primary}_nexus_data:/data:ro" \
  "$image" tar -czf - -C /data . > "$work/backup.tgz"

compose "$restored" create --no-build --pull never
docker run --rm -i --network none --user 0:0 -v "${restored}_nexus_data:/data" \
  "$image" tar -xzf - -C /data < "$work/backup.tgz"
compose "$restored" start
base=$(ready "$restored")
json_post -c "$work/session" -d "$login" "$base/api/auth/login" >/dev/null
verify_directory "$base"
printf 'Backup restored to a new volume; admin, groups, services and events verified.\n'

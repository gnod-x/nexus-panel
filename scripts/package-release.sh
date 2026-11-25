#!/usr/bin/env bash
set -euo pipefail

root=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)
output=$(realpath -m -- "${1:-$root/release}")
version=$(python3 -c 'import json, sys; print(json.load(sys.stdin)["version"])' < "$root/package.json")
image="nexus-panel:$version"
platform=$(docker image inspect --format '{{.Os}}-{{.Architecture}}' "$image")
bundle="nexus-panel-v${version}-${platform}"
work=$(mktemp -d)
trap 'rm -rf -- "$work"' EXIT
mkdir -p -- "$output" "$work/$bundle"

cp -- "$root/docker-compose.yml" "$root/.env.example" "$root/LICENSE" "$root/THIRD_PARTY_NOTICES.md" "$work/$bundle/"
mkdir -p -- "$work/$bundle/docs" "$work/$bundle/examples" "$work/$bundle/scripts" "$work/$bundle/licenses"
cp -R -- "$root/docs/." "$work/$bundle/docs/"
printf '# Deployment\n\nSee [the deployment guide](docs/deployment.md) for installation, configuration, upgrades, backup and recovery.\n' > "$work/$bundle/deployment.md"
cp -- "$root/src/client/fonts/OFL.txt" "$work/$bundle/licenses/LiuJianMaoCao-OFL.txt"
cp -- "$root/examples/integrations.example.json" "$work/$bundle/examples/"
cp -- "$root/scripts/collect-tasks.py" "$work/$bundle/scripts/"
docker image save -o "$work/$bundle/nexus-panel-image.tar" "$image"
tar -czf "$work/$bundle.tar.gz" -C "$work" "$bundle"
mv -- "$work/$bundle.tar.gz" "$output/"
(cd -- "$output" && sha256sum -- "$bundle.tar.gz" > "$bundle.tar.gz.sha256")
printf '%s/%s.tar.gz\n' "$output" "$bundle"

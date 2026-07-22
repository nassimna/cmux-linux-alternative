#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 RELEASE_DIRECTORY VERSION" >&2
  exit 64
fi

release_directory=$(realpath "$1")
version=$2
[[ $version =~ ^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$ ]] || {
  echo "invalid release version: $version" >&2
  exit 64
}

expected=(
  "agent-workspace-${version}-x86_64.AppImage"
  "agent-workspace-${version}-x86_64.deb"
  "agent-workspace-${version}-x86_64.rpm"
)
cd "$release_directory"
[[ -f SHA256SUMS && ! -L SHA256SUMS ]] || { echo 'missing regular SHA256SUMS' >&2; exit 1; }
for artifact in "${expected[@]}"; do
  [[ -f $artifact && ! -L $artifact ]] || { echo "missing regular artifact: $artifact" >&2; exit 1; }
done
[[ $(wc -l < SHA256SUMS) -eq 3 ]] || { echo 'SHA256SUMS must have exactly three entries' >&2; exit 1; }
sha256sum --strict --check SHA256SUMS


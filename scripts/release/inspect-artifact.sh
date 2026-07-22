#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 TYPE ARTIFACT" >&2
  exit 64
fi
type=$1
artifact=$(realpath "$2")
[[ -f $artifact && ! -L $artifact ]] || { echo "artifact is not a regular file: $artifact" >&2; exit 1; }

require_sidecars() {
  local listing=$1
  grep -Eq 'resources/bin/agent-workspace-service$' <<<"$listing" || { echo 'service sidecar missing' >&2; exit 1; }
  grep -Eq 'resources/bin/agent-workspace-cli$' <<<"$listing" || { echo 'CLI sidecar missing' >&2; exit 1; }
}

case "$type" in
  deb) require_sidecars "$(dpkg-deb --contents "$artifact" | awk '{print $NF}')" ;;
  rpm) require_sidecars "$(rpm --query --package --list "$artifact")" ;;
  appimage)
    scratch=$(mktemp -d)
    trap 'rm -rf "$scratch"' EXIT
    (cd "$scratch" && chmod +x "$artifact" && "$artifact" --appimage-extract >/dev/null)
    [[ -x $scratch/squashfs-root/AppRun ]] || { echo 'AppImage AppRun is missing' >&2; exit 1; }
    [[ -x $scratch/squashfs-root/resources/bin/agent-workspace-service ]] || { echo 'service sidecar missing' >&2; exit 1; }
    [[ -x $scratch/squashfs-root/resources/bin/agent-workspace-cli ]] || { echo 'CLI sidecar missing' >&2; exit 1; }
    ;;
  *) echo "unsupported artifact type: $type" >&2; exit 64 ;;
esac


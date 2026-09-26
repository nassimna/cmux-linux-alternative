#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 TYPE ARTIFACT" >&2
  exit 64
fi
type=$1
artifact=$(realpath "$2")
[[ -f $artifact && ! -L $artifact ]] || { echo "artifact is not a regular file: $artifact" >&2; exit 1; }

require_node_runtime() {
  local listing=$1
  for file in bin/node bin/agent-workspace-node.mjs server/dist/bin.mjs server/dist/rename-exchange.node server/dist/seal-executable.node manifest.json; do
    grep -Eq "resources/node-linux/$file$" <<<"$listing" || { echo "Node runtime file missing: $file" >&2; exit 1; }
  done
}

case "$type" in
  deb) require_node_runtime "$(dpkg-deb --contents "$artifact" | awk '{print $NF}')" ;;
  rpm) require_node_runtime "$(rpm --query --package --list "$artifact")" ;;
  appimage)
    scratch=$(mktemp -d)
    trap 'rm -rf "$scratch"' EXIT
    (cd "$scratch" && chmod +x "$artifact" && "$artifact" --appimage-extract >/dev/null)
    [[ -x $scratch/squashfs-root/AppRun ]] || { echo 'AppImage AppRun is missing' >&2; exit 1; }
    [[ -x $scratch/squashfs-root/resources/node-linux/bin/node ]] || { echo 'Node executable missing' >&2; exit 1; }
    [[ -f $scratch/squashfs-root/resources/node-linux/server/dist/bin.mjs ]] || { echo 'Node service missing' >&2; exit 1; }
    [[ -f $scratch/squashfs-root/resources/node-linux/bin/agent-workspace-node.mjs ]] || { echo 'Node CLI missing' >&2; exit 1; }
    [[ -f $scratch/squashfs-root/resources/node-linux/manifest.json ]] || { echo 'Node manifest missing' >&2; exit 1; }
    ;;
  *) echo "unsupported artifact type: $type" >&2; exit 64 ;;
esac


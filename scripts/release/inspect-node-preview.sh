#!/usr/bin/env bash
set -euo pipefail

if [[ $# -ne 2 ]]; then
  echo "usage: $0 ARTIFACT AppImage|deb|rpm" >&2
  exit 64
fi
artifact=$(realpath "$1")
type=$2
[[ -f $artifact && ! -L $artifact ]] || { echo "preview artifact is not a regular file" >&2; exit 1; }
scratch=$(mktemp -d)
trap 'rm -rf "$scratch"' EXIT

case "$type" in
  AppImage)
    (cd "$scratch" && "$artifact" --appimage-extract >/dev/null)
    ;;
  deb)
    dpkg-deb --extract "$artifact" "$scratch"
    ;;
  rpm)
    (cd "$scratch" && rpm2cpio "$artifact" | cpio --extract --make-directories --quiet)
    ;;
  *) echo "unsupported preview artifact type: $type" >&2; exit 64 ;;
esac

mapfile -t runtimes < <(find "$scratch" -type d -path '*/resources/node-linux' -print)
if [[ ${#runtimes[@]} -ne 1 ]]; then
  echo "expected exactly one packaged Node runtime, found ${#runtimes[@]}" >&2
  exit 1
fi
node "$(dirname "$0")/verify-node-preview.mjs" "${runtimes[0]}"

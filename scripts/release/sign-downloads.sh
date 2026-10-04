#!/usr/bin/env bash
set -euo pipefail

: "${MINISIGN_SECRET_KEY:?Configure MINISIGN_SECRET_KEY before publishing a release}"
release_directory=$(cd "${1:?Usage: sign-downloads.sh RELEASE_DIRECTORY}" && pwd)
repository_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
public_key="$repository_directory/apps/website/public/ternline.pub"

cmp "$public_key" "$release_directory/ternline.pub"
(cd "$release_directory" && sha256sum --strict --check SHA256SUMS)

key_directory=$(mktemp -d "${RUNNER_TEMP:-${TMPDIR:-/tmp}}/ternline-signing.XXXXXX")
trap 'rm -rf -- "$key_directory"' EXIT
umask 077
printf '%s\n' "$MINISIGN_SECRET_KEY" > "$key_directory/ternline.key"
unset MINISIGN_SECRET_KEY

for artifact in "$release_directory"/*; do
  case "$artifact" in
    *.sig|*/ternline.pub) continue ;;
  esac
  if [[ ! -f "$artifact" || -L "$artifact" ]]; then
    printf 'Release asset must be a regular file: %s\n' "$artifact" >&2
    exit 1
  fi
  minisign -S -s "$key_directory/ternline.key" -m "$artifact" \
    -x "$artifact.sig" -t "Ternline download: ${artifact##*/}"
  minisign -V -p "$public_key" -m "$artifact" -x "$artifact.sig"
done

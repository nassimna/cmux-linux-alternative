#!/usr/bin/env bash
set -euo pipefail

repository_directory=$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)
mkdir -p "$repository_directory/target"
fixture=$(mktemp -d "$repository_directory/target/sign-downloads-test.XXXXXX")
trap 'rm -rf -- "$fixture"' EXIT
mkdir -p "$fixture/scripts/release" "$fixture/apps/website/public" "$fixture/assets"
cp "$repository_directory/scripts/release/sign-downloads.sh" "$fixture/scripts/release/"
public_key="$fixture/apps/website/public/ternline.pub"
minisign -G -W -s "$fixture/ternline.key" -p "$public_key" > /dev/null
cp "$public_key" "$fixture/assets/ternline.pub"
assets=(test.AppImage test.deb test.rpm test.dmg test.zip test.exe alpha.yml release-manifest.json)
for name in "${assets[@]}"; do
  printf 'Original release bytes: %s\n' "$name" > "$fixture/assets/$name"
done
(cd "$fixture/assets" && sha256sum ternline.pub "${assets[@]}" > SHA256SUMS)

MINISIGN_SECRET_KEY=$(cat "$fixture/ternline.key") TMPDIR="$fixture" \
  bash "$fixture/scripts/release/sign-downloads.sh" "$fixture/assets" > "$fixture/sign.log" 2>&1
for artifact in "$fixture/assets"/*; do
  case "$artifact" in
    *.sig|*/ternline.pub) continue ;;
  esac
  minisign -V -q -p "$public_key" -m "$artifact" -x "$artifact.sig"
done
printf 'Tampered bytes\n' >> "$fixture/assets/test.exe"
if minisign -V -q -p "$public_key" -m "$fixture/assets/test.exe" \
  -x "$fixture/assets/test.exe.sig" > /dev/null 2>&1; then
  printf 'Tampered installer was accepted\n' >&2
  exit 1
fi
printf 'Original release bytes: test.exe\n' > "$fixture/assets/test.exe"
printf 'Tampered checksum manifest\n' >> "$fixture/assets/SHA256SUMS"
if minisign -V -q -p "$public_key" -m "$fixture/assets/SHA256SUMS" \
  -x "$fixture/assets/SHA256SUMS.sig" > /dev/null 2>&1; then
  printf 'Tampered checksum manifest was accepted\n' >&2
  exit 1
fi
(cd "$fixture/assets" && sha256sum ternline.pub "${assets[@]}" > SHA256SUMS)
rm -- "$fixture/assets"/*.sig
printf 'PASS: every release asset is signed; tampered installers and checksums are rejected\n'

minisign -G -W -s "$fixture/other.key" -p "$fixture/other.pub" > /dev/null
if MINISIGN_SECRET_KEY=$(cat "$fixture/other.key") TMPDIR="$fixture" \
  bash "$fixture/scripts/release/sign-downloads.sh" "$fixture/assets" > "$fixture/mismatch.log" 2>&1; then
  printf 'Mismatched signing key was accepted\n' >&2
  exit 1
fi
minisign -V -q -p "$fixture/other.pub" -m "$fixture/assets/SHA256SUMS" \
  -x "$fixture/assets/SHA256SUMS.sig"
printf 'PASS: a signing key that does not match the published public key blocks signing\n'

if env -u MINISIGN_SECRET_KEY bash "$fixture/scripts/release/sign-downloads.sh" "$fixture/assets" \
  > "$fixture/missing-key.log" 2>&1; then
  printf 'Missing signing key was accepted\n' >&2
  exit 1
fi
grep -q 'Configure MINISIGN_SECRET_KEY' "$fixture/missing-key.log"
printf 'PASS: a missing signing key blocks signing\n'

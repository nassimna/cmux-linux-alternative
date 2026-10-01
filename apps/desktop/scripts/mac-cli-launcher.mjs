export function createMacCliLauncher(productFilename) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  return `#!/bin/sh
# Use the application's embedded Node runtime; a separate Node installation is unnecessary.
contents_dir=$(CDPATH= cd -- "$(dirname -- "$0")/../.." && pwd) || exit 1
unset NODE_OPTIONS NODE_PATH ELECTRON_NO_ASAR
export ELECTRON_RUN_AS_NODE=1
exec "$contents_dir"/MacOS/${quote(productFilename)} "$contents_dir/Resources/cli/dist/bin.mjs" "$@"
`
}

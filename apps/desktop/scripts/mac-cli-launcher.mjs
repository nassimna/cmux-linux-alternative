export function createMacCliLauncher(productFilename) {
  const quote = (value) => `'${value.replaceAll("'", "'\\''")}'`
  return `#!/bin/sh
# Use the application's embedded Node runtime; a separate Node installation is unnecessary.
launcher_path=$0
links=0
while [ -L "$launcher_path" ]; do
    links=$((links + 1))
    [ "$links" -le 40 ] || exit 1
    target=$(/usr/bin/readlink "$launcher_path") || exit 1
    case "$target" in
        /*) launcher_path=$target ;;
        *) launcher_path=$(dirname -- "$launcher_path")/$target ;;
    esac
done
contents_dir=$(CDPATH= cd -- "$(dirname -- "$launcher_path")/../.." && pwd) || exit 1
unset NODE_OPTIONS NODE_PATH ELECTRON_NO_ASAR
export ELECTRON_RUN_AS_NODE=1
exec "$contents_dir"/MacOS/${quote(productFilename)} "$contents_dir/Resources/app.asar/cli/dist/bin.mjs" "$@"
`
}

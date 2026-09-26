# Installation

There is no published download or supported stable release today. The repository can build
x86_64 AppImage, Debian, and RPM candidates, but those artifacts are local qualification output.
Before publication the project needs a final public identity, a real homepage/repository URL,
maintainer-owned signing keys, a hosted update origin, and completed release gates. The current
reserved `.invalid` homepage exists only to let local deb/rpm packaging proceed.

macOS and Windows are outside the current Node package and release qualification. There is no
qualified download for either platform.

## End-user prerequisites

Use a current x86_64 Linux desktop with X11 or Wayland and the runtime libraries resolved by the
package manager. AppImage users may also need FUSE 2 compatibility. The current artifacts have not
been qualified on ARM64, macOS, or Windows; the native package sections below describe contributor
qualification only, not supported end-user releases.

Obtain all four files from the same trusted build:

```text
agent-workspace-VERSION-x86_64.AppImage
agent-workspace-VERSION-x86_64.deb
agent-workspace-VERSION-x86_64.rpm
SHA256SUMS
```

Verify the complete set before installing:

```sh
sha256sum --check SHA256SUMS
```

SHA-256 detects mismatch with the supplied manifest; it is not a substitute for release signing
or trusted delivery. Current local artifacts are unsigned.

## Install and launch

AppImage:

```sh
chmod +x agent-workspace-VERSION-x86_64.AppImage
./agent-workspace-VERSION-x86_64.AppImage
```

Debian/Ubuntu:

```sh
sudo apt install ./agent-workspace-VERSION-x86_64.deb
agent-workspace
```

Fedora/RHEL-family:

```sh
sudo dnf install ./agent-workspace-VERSION-x86_64.rpm
agent-workspace
```

Deb/rpm packages install a desktop entry through the package manager. AppImage desktop-menu
integration depends on the user's AppImage integration tooling and is not performed by the app.
The package includes an original project icon in the standard Linux hicolor sizes. The icon remains
temporary until the public project identity is selected.

## User data and runtime files

Electron's Linux user-data root is normally `$XDG_CONFIG_HOME/Agent Workspace`, or
`~/.config/Agent Workspace` when `XDG_CONFIG_HOME` is unset. The exact root follows Electron's
`userData` path for the current product name. Important children are:

```text
configuration/desktop.json
state/workspace.sqlite
logs/
secrets/control-token.enc       # only when secure OS storage is available
```

The live control socket and CLI session record normally reside under
`$XDG_RUNTIME_DIR/agent-workspace/`. A per-user temporary-runtime directory is used if
`XDG_RUNTIME_DIR` is absent. Runtime records are ephemeral; do not back them up or share them.

## Uninstall

Package removal intentionally preserves user data:

```sh
sudo apt remove agent-workspace
sudo dnf remove agent-workspace
```

For an AppImage, stop the application and delete only the AppImage and any desktop integration you
created. To perform a destructive clean removal, first back up anything required, stop all running
instances, uninstall the package, and then explicitly remove Electron's `userData` directory shown
above. Deleting that directory removes workspaces, configuration, logs, and stored credentials and
cannot be undone.

## Troubleshooting

- If an AppImage reports a FUSE error, install the distribution's FUSE 2 compatibility package or
  extract it with `--appimage-extract` and run `squashfs-root/AppRun`. Extraction is a diagnostic
  fallback; updater support requires launching the real AppImage so the `APPIMAGE` environment
  variable identifies it.
- On headless systems, Electron needs a display. The clean-container probes use Xvfb; that is not a
  full desktop qualification.
- Wayland may use XWayland depending on Electron and desktop configuration. Native Wayland, GPU,
  FUSE mounting, desktop-menu integration, and notification behavior still require real-host
  qualification. Use X11 as a diagnostic comparison if rendering or focus fails.
- If the CLI cannot find the service, keep the desktop running and see [CLI discovery](CLI.md).
- If update controls say unavailable, see [desktop updates](UPDATES.md); default packages are
  intentionally feed-free and both trusted runtime feed roots are required.

## Building instead of installing

Contributors need Node.js 22.22.3, pnpm 10.34.5, a native-addon build toolchain, and Electron's
Linux development libraries. See [CONTRIBUTING.md](../CONTRIBUTING.md) for build and validation
commands. Building from source is not equivalent to installing a qualified release.

### Install a local Linux build in the application launcher

On an x86_64 Linux development host, build the bundled Node runtime and an AppImage, then install it at
a stable per-user path with one command:

```sh
pnpm package:linux:local
```

The command atomically replaces
`$XDG_DATA_HOME/agent-workspace/agent-workspace.AppImage` (or
`~/.local/share/agent-workspace/agent-workspace.AppImage`), makes it executable, installs the
512x512 hicolor icon, and writes `agent-workspace.desktop` under the per-user `applications`
directory. Re-running the command updates the existing launcher target in place. It builds only the
x64 AppImage and stages that local candidate below `target/local-appimage/`; it does not create or
modify the versioned AppImage/deb/rpm set or its `SHA256SUMS` release contract.

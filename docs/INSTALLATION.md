# Installation

Choose your platform on the [Ternline website](https://nassimna.github.io/cmux-linux-alternative/),
or open the [GitHub releases](https://github.com/nassimna/cmux-linux-alternative/releases).
The website recommends your OS and offers every installer so you can choose another machine or
architecture. On Macs that do not expose their CPU architecture to the browser, choose Apple
Silicon or Intel manually using **About This Mac**.

The current release is an unsigned prerelease. It does not include macOS notarization or Windows
Authenticode signing and may show an operating-system trust prompt. There is no stable support
guarantee. Only install assets from this project's release page after verifying their checksums.

## Packages and prerequisites

| Platform | Architecture                     | Packages                                           |
| -------- | -------------------------------- | -------------------------------------------------- |
| Linux    | x86_64                           | AppImage, Debian/Ubuntu `.deb`, Fedora/RHEL `.rpm` |
| macOS    | Apple Silicon arm64 or Intel x64 | `.dmg` and updater `.zip`                          |
| Windows  | x64                              | Per-user NSIS `.exe` installer                     |

Linux needs a desktop session and the runtime libraries resolved by the package manager.
AppImage users may also need FUSE 2 compatibility. Linux ARM64 and Windows ARM64 installers are
not provided. macOS and Windows package checks run on native hosted runners; they do not qualify
every physical device or OS version.

Download the installer and `SHA256SUMS` from the **same release**. Verify only the downloaded file;
the manifest also contains installers for the other platforms:

```sh
sha256sum agent-workspace-VERSION-x86_64.AppImage
grep 'agent-workspace-VERSION-x86_64.AppImage$' SHA256SUMS
```

On macOS use `shasum -a 256 FILE`. On Windows use `Get-FileHash FILE -Algorithm SHA256` in
PowerShell. Compare the complete hash to the matching filename in `SHA256SUMS`. SHA-256 detects
mismatch with the supplied manifest; it does not replace code signing or trusted delivery.

## Install and launch

Linux AppImage:

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
integration depends on your AppImage tooling. The package includes the Ternline icon in standard
Linux hicolor sizes.

On macOS, open the DMG and drag **Ternline** into **Applications**. On Windows, run the EXE and
choose an installation directory; the installer creates desktop and Start menu shortcuts and
preserves user data on uninstall. The zip on macOS is used by the updater and is also available
for manual extraction.

The CLI is available in terminals opened inside Ternline. macOS packages include
`Ternline.app/Contents/Resources/cli/ternline-cli`; Windows packages include
`resources/cli/ternline-cli.cmd`. See the [CLI reference](CLI.md) for external-agent setup.

## User data and runtime files

Ternline preserves the `Agent Workspace` user-data directory:

- Linux: `$XDG_CONFIG_HOME/Agent Workspace`, or `~/.config/Agent Workspace`.
- macOS: `~/Library/Application Support/Agent Workspace`.
- Windows: `%APPDATA%\Agent Workspace`.

Important children are:

```text
configuration/desktop.json
state/workspace.sqlite
logs/
secrets/control-token.enc       # only when secure OS storage is available
```

The Node CLI session record is `runtime/node-cli-session.json` inside that directory. It contains
a local connection credential, is ephemeral, and must not be shared or backed up.

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
- If update controls say unavailable, see [desktop updates](UPDATES.md). Published packages use
  GitHub Releases; unpacked or development builds cannot install updates.

## Building instead of installing

Contributors need Node.js 22.23.3, pnpm 10.34.5, a native-addon build toolchain, and Electron's
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

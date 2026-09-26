# Linux Node packaging

The Linux x64 desktop package carries Node 22.22.3, the TypeScript server, CLI, native addons,
and a runtime manifest at `resources/node-linux`. The Electron main process launches the Node
server from that staged runtime. Existing profiles receive a pre-Node database backup; legacy
settings and trusted host records are checked before normal startup.

## Install locally

```sh
pnpm package:linux:local
```

This creates `target/local-appimage/agent-workspace-0.1.0-x86_64.AppImage` and installs:

- AppImage: `~/.local/share/agent-workspace/agent-workspace.AppImage`
- Desktop launcher: `~/.local/share/applications/agent-workspace.desktop`
- CLI: `~/.local/bin/agent-workspace-cli`, backed by a bundled Node executable and JavaScript
  under `~/.local/share/agent-workspace/cli`.

`XDG_DATA_HOME` overrides the application and launcher location. The CLI discovers the running
desktop's private session record, respecting `XDG_CONFIG_HOME`; `--session-file` selects another
profile explicitly. Run `agent-workspace-cli --help` for supported commands.

Linux requires Electron's system libraries, OpenSSH, bubblewrap, and a running Secret Service
such as KDE Wallet for encrypted search and managed SSH credentials. Managed SSH sessions require
tmux 3.2 or newer on the remote host. Codex/Claude integrations require their respective CLIs and
authentication. Node itself is bundled.

For managed SSH detach/reconnect, the remote tmux server must retain unattached sessions. Set
`destroy-unattached off` and `exit-unattached off` in that host's tmux configuration; the desktop
does not change the remote user's tmux settings.

## Build distribution artifacts

From a clean checkout with Node 22.22.3 and pnpm 10.34.5:

```sh
pnpm install --frozen-lockfile
pnpm package:linux
```

`pnpm package:linux` builds the server and CLI, stages the self-contained runtime in
`target/node-linux`, builds Electron, and produces AppImage, deb, and rpm candidates under
`release/`. The stage script verifies its manifest, bundled native addons, and CLI before reuse;
if existing build inputs differ, it refuses to overwrite the stage. Remove a stale stage only
after confirming it belongs to this checkout.

Check any candidate with `scripts/release/inspect-node-preview.sh ARTIFACT AppImage|deb|rpm`.
The inspector extracts the artifact and verifies the packaged Node executable, server, CLI,
native addons, and hashes. `scripts/release/launch-probe.sh` additionally tests that the
packaged desktop starts a Node server and a renderer under an isolated test profile.

macOS and Windows packages are outside the current Node cutover qualification.

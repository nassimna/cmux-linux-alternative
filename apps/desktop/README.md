# Desktop application

Electron owns native windows, the typed preload bridge, browser views, system dialogs, and the
Node service lifecycle. The React renderer lives in `apps/web`; privileged domain behavior lives
in `apps/server`. The renderer cannot call Node APIs directly.

Linux packages contain a pinned Node runtime, the server, the CLI, and required native addons.
No separate Node installation is needed to run the installed application.

From the repository root:

```sh
pnpm dev
pnpm package:linux:local
```

The local packaging command builds an AppImage, installs its launcher and icon, and installs
`agent-workspace-cli` with its own bundled Node runtime. See
[Linux packaging](../../docs/node-linux-packaging.md) for paths and requirements.

Existing profiles are backed up before the first Node database mutation. Legacy settings and
trusted host records are checked during startup. Failed migration keeps the recovery interface
available rather than replacing the user's profile.

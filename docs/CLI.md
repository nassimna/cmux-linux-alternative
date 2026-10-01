# Command-line interface

## macOS

The Mac package includes `ternline-cli` and uses the application's embedded Node runtime.
No separate Node installation is needed. Use the `.pkg` installer for the app and external CLI:
it installs `/Applications/Ternline.app` and `/usr/local/bin/ternline-cli` together. macOS asks
for administrator authorization during installation. An unrelated or modified command at that
path is preserved and prevents installation. Quit Ternline before updating it through Installer.

Open Ternline after installation. The command works inside Ternline and in external terminals
whose PATH includes `/usr/local/bin` (the standard macOS shell configuration):

```sh
ternline-cli identify
ternline-cli --help
```

Keep Ternline running for commands that control it. The CLI discovers the private local session
automatically on macOS. The app and installer do not edit shell startup files.

The `.dmg` and `.zip` packages remain available for drag-and-drop installation. Their bundled
CLI works automatically inside Ternline through the app's terminal environment; external
terminals can invoke the bundled command directly:

```sh
"/Applications/Ternline.app/Contents/Resources/cli/ternline-cli" identify
```

## Linux

The Linux desktop package includes `resources/node-linux/bin/agent-workspace-node.mjs` and its
pinned Node executable at `resources/node-linux/bin/node`. Run the CLI with that executable:

```sh
/path/to/resources/node-linux/bin/node /path/to/resources/node-linux/bin/agent-workspace-node.mjs --help
```

The CLI connects to the running Node service through its private session record. On Linux it
can discover the desktop's owner-only record; `--session-file PATH` or
`AGENT_WORKSPACE_NODE_SESSION_FILE` selects another record. Do not copy its bearer token to a
shell command. The CLI prints JSON responses to stdout and errors to stderr.

Use `--help` for the current command list and argument requirements. It covers workspace,
terminal, layout, remote session, agent, notification, action, search, file, and browser
operations. Examples:

```sh
agent-workspace-node workspace list
agent-workspace-node workspace create --name Project --working-directory /absolute/project
agent-workspace-node terminal send --terminal-id TERMINAL_UUID --data $'pwd\n'
```

The local `hook install`, `hook uninstall`, and `hook status` commands do not require a running
desktop. Agent hooks consume bounded input and publish through the authenticated Node service.

# Command-line interface

## macOS

The Mac package includes `ternline-cli` and uses the application's embedded Node runtime.
No separate Node installation is needed. Open the `.dmg` and drag Ternline to Applications.
The `.zip` also contains the same app bundle.

Open Ternline after installation. The command works automatically inside Ternline:

```sh
ternline-cli identify
ternline-cli --help
```

For external terminals, open the command palette (⌘⇧P), search **Install ternline-cli**, and run
the action. It creates `/usr/local/bin/ternline-cli` as a symlink to the bundled command. macOS
requests administrator authorization only if needed to write there. External shells must have
`/usr/local/bin` on PATH (the standard macOS configuration). The **Uninstall ternline-cli** action
removes this external command while keeping the bundled CLI available inside Ternline.

Installation preserves unrelated commands and shell startup files. A launcher installed by the
previous Ternline `.pkg` can be replaced by the new symlink. Keep Ternline running for commands
that control it; the CLI discovers the private local session automatically on macOS.

External terminals can also invoke the bundled command directly without installing the symlink:

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

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
agent-workspace-node workspace close --workspace-id WORKSPACE_UUID
agent-workspace-node terminal send --terminal-id TERMINAL_UUID --data $'pwd\n'
agent-workspace-node terminal ports --terminal-id TERMINAL_UUID
```

`terminal ports` returns the terminal ID and its sorted `listeningPorts` array from the runtime
metadata endpoint. `workspace close` targets the specified workspace and obtains the current
revision, idempotency epoch, and a new request key automatically. To retry the same close after
a lost response, supply both `--expected-revision N` and the original `--idempotency-key UUID`.

Browser operations print `operation.result` by default. Add `--verbose` for the full session and
operation response. A new `browser open` still includes `session.automationSessionId` so later
commands can target it; `browser attach` and the raw `browser-automation` commands retain their
full responses. For example:

```sh
ternline-cli browser open --url http://127.0.0.1:5174
ternline-cli browser eval --session-id SESSION_UUID --expression 'document.title'
ternline-cli browser snapshot --session-id SESSION_UUID --verbose
```

Each browser command obtains the current session generation and navigation epoch. If navigation
races with execution, it refreshes the session and retries `stale_navigation` once. Other failures
are reported immediately. Evaluation failures include `evaluation_failed`, the page error message,
and its stack when available. Evaluation retains the script value when it changes the URL and
includes a separate `navigation` field. Query results use the real HTML `tag` and a separate `role`.
Attachment waits up to five seconds for a new tab; approval denial and the 60-second approval
deadline return `approval_denied` and `approval_timeout`. Console/error follow mode emits compact diagnostic results unless
`--verbose` is supplied. Screenshot and recording output retain the saved `output` path; artifact
bytes are verified and the handle is released after saving. Stopped WebM recordings include duration
and seek metadata.

The local `hook install`, `hook uninstall`, and `hook status` commands do not require a running
desktop. Agent hooks consume bounded input and publish through the authenticated Node service.

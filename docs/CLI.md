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

## Lightpanda page reading

`browser fetch` is an experimental, opt-in command for agents that need page content after
JavaScript execution. It runs without a desktop or private session file. Install
[Lightpanda 1.0.0](https://github.com/lightpanda-io/browser/releases/tag/1.0.0) separately;
Ternline does not download or bundle it. Linux and macOS executables are available; native
Windows is not supported by Lightpanda. Run the CLI and Linux executable inside WSL on Windows.

```sh
ternline-cli browser fetch --engine lightpanda --url https://nassimna.github.io/ternline/ --executable /absolute/path/to/lightpanda
ternline-cli browser fetch --engine lightpanda --url http://localhost:3000 --format html --wait-selector '#ready'
```

`--executable` defaults to `LIGHTPANDA_EXECUTABLE`, then `lightpanda` on PATH. `--format` is
`markdown` (default) or `html`. The JSON response has `engine`, `format`, and `result`;
`result` is Lightpanda's fetch JSON, including `url`, `http_status`, `content`, and `error`.
The content includes DOM changes made by page scripts. Lightpanda waits for page load by
default; `--wait-selector` waits for a CSS selector on asynchronous pages, within Lightpanda's
five-second readiness window. Empty pages may return empty content. Navigation, readiness,
and HTTP 400+ errors fail with a nonzero CLI exit.

`--timeout-ms` is a hard process deadline, default 30,000ms and maximum 120,000ms. Each output
stream is limited to 1 MiB and each HTTP response to 8 MiB; overflow fails rather than returning
partial output. Each command starts a fresh process without loading or saving desktop cookies
or profiles. Telemetry and crash dumps are disabled. These bounds do not cap total process memory.

This command executes website JavaScript in an external executable. It does not inherit the
embedded browser's sandbox, permission, or navigation policy. HTTP(S) entry URLs must have no
credentials; page scripts and redirects can still reach other URLs, including local services.
It provides content reading, with no authenticated desktop attachment, form interaction,
rendered screenshots, or recordings. Use the existing Chromium browser commands for those
journeys and for visual testing. See [Lightpanda's architecture](https://lightpanda.io/docs/core-concepts/architecture-overview)
and [fetch reference](https://lightpanda.io/docs/reference/cli/fetch).

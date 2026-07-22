# Command-line interface

The packaged `agent-workspace-cli` talks to the running desktop's local Rust service. Every remote
command prints one compact JSON value on stdout and writes errors to stderr. The desktop must be
running, except for the local `hook install`, `hook uninstall`, and `hook status` commands.

## Discovery and authentication

The CLI discovers the owner-only session record in this order:

1. global `--session-file PATH`;
2. `AGENT_WORKSPACE_SESSION_FILE`;
3. `$XDG_RUNTIME_DIR/agent-workspace/cli-session.json` on Linux, with a per-user temporary-runtime
   fallback when `XDG_RUNTIME_DIR` is unavailable.

The option is global and may appear before or after a subcommand. It identifies a record path, not
a credential. There is deliberately no token flag: never copy the token out of the session record
or place it in shell history. The generated Clap interface does not currently provide a shell
completion generator.

Use `agent-workspace-cli --help` and nested `--help` for the authoritative interface.

## Command summary

| Command                               | Required arguments                                                          | Optional arguments                                                                                                   |
| ------------------------------------- | --------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `identify`                            | none                                                                        | global `--session-file`                                                                                              |
| `workspace list`                      | none                                                                        | global `--session-file`                                                                                              |
| `workspace create`                    | `--name`, absolute `--working-directory`                                    | `--description`, `--color`, absolute `--terminal-cwd`, `--rows` (24), `--cols` (80), trailing `--command COMMAND...` |
| `terminal create`                     | `--workspace-id`, `--pane-id`, absolute `--cwd`                             | `--destination-index`, `--rows` (24), `--cols` (80), `--command COMMAND...`                                          |
| `terminal send`                       | `--terminal-id`, `--data`                                                   | none                                                                                                                 |
| `pane split`                          | `--workspace-id`, `--target-pane-id`, `--axis`, then one content subcommand | `--placement` (`after`), `--ratio` (`0.5`)                                                                           |
| `notify`                              | `--title`                                                                   | `--body`, `--level` (`info`), `--workspace-id`, `--pane-id`, `--tab-id`                                              |
| `hook codex`                          | JSON `PAYLOAD` argv                                                         | global `--session-file`                                                                                              |
| `hook claude`                         | bounded JSON on stdin                                                       | global `--session-file`                                                                                              |
| `hook install`, `uninstall`, `status` | agent `codex` or `claude`                                                   | none                                                                                                                 |

Pane content is exactly one of `terminal --cwd PATH [--rows N --cols N --command COMMAND...]`,
`browser --url URL [--profile-partition NAME]`, or `existing-tab --tab-id UUID`. Terminal rows and
columns accept 1–65535. A split ratio must be greater than 0 and less than 1.

## Examples

Identify the service and list the complete workspace snapshot:

```sh
agent-workspace-cli identify
agent-workspace-cli workspace list
```

Create a workspace and its initial 24-row by 80-column terminal. Working directories must be
absolute. `--terminal-cwd` defaults to `--working-directory`.

```sh
agent-workspace-cli workspace create \
  --name "Project" \
  --working-directory /absolute/path/to/project

agent-workspace-cli workspace create \
  --name "Tests" \
  --working-directory /absolute/path/to/project \
  --rows 30 --cols 120 \
  --command bash -lc 'pnpm test'
```

Put `--command` last when its values begin with `-`. Create another terminal using workspace and
pane IDs returned by `workspace list`, or send raw UTF-8 input to a terminal ID:

```sh
agent-workspace-cli terminal create \
  --workspace-id WORKSPACE_UUID --pane-id PANE_UUID \
  --cwd /absolute/path/to/project

agent-workspace-cli terminal send --terminal-id TERMINAL_UUID --data $'pwd\n'
```

`terminal input` is an alias for `terminal send`. Input is raw text at the command line and is
base64-encoded only on the protocol wire.

Split a pane before or after the target. `--ratio` defaults to `0.5`; the axis is `horizontal` or
`vertical`, and placement is `before` or `after`.

```sh
agent-workspace-cli pane split \
  --workspace-id WORKSPACE_UUID --target-pane-id PANE_UUID \
  --axis vertical --placement after --ratio 0.5 \
  terminal --cwd /absolute/path/to/project

agent-workspace-cli pane split \
  --workspace-id WORKSPACE_UUID --target-pane-id PANE_UUID \
  --axis horizontal browser --url https://example.com/

agent-workspace-cli pane split \
  --workspace-id WORKSPACE_UUID --target-pane-id PANE_UUID \
  --axis vertical existing-tab --tab-id TAB_UUID
```

Publish a notification. The level defaults to `info`; valid values are `info`, `warning`, and
`error`. Omit all target IDs to target the currently selected workspace, or provide the desired
workspace/pane/tab IDs. The corresponding `AGENT_WORKSPACE_WORKSPACE_ID`,
`AGENT_WORKSPACE_PANE_ID`, and `AGENT_WORKSPACE_TAB_ID` environment variables provide hook-friendly
defaults; explicit flags win.

```sh
agent-workspace-cli notify --title "Build complete" --level info
agent-workspace-cli notify --title "Review needed" --body "Tests failed" \
  --level warning --workspace-id WORKSPACE_UUID --pane-id PANE_UUID --tab-id TAB_UUID
```

## Agent hooks

Installers are explicit, reversible, and conflict-aware:

```sh
agent-workspace-cli hook status codex
agent-workspace-cli hook install codex
agent-workspace-cli hook uninstall codex
agent-workspace-cli hook status claude
```

The adapter entry points are `hook codex PAYLOAD` for Codex's JSON argv payload and `hook claude`
for Claude Code's bounded JSON stdin. Prefer the installer rather than hand-editing agent settings.
See the [agent integration guide](AGENT_INTEGRATIONS.md) for exact files, conflict behavior, and
sanitization guarantees.

## Scope and limits

The public CLI currently covers identify, workspace list/create, terminal create/send, pane split,
notifications, and hooks. It is not a generic protocol escape hatch and cannot supply arbitrary
commands, raw authentication tokens, or browser automation. Requests time out after a bounded
interval and fail if the desktop session record is absent, stale, insecure, or incompatible.

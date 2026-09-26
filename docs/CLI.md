# Command-line interface

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

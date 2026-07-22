# Agent integrations

The public `agent-workspace-cli` can publish notifications directly and can explicitly install
user-level notification hooks for Codex and Claude Code. Hook configuration always invokes the
absolute public CLI path. It never contains a control endpoint, socket path, session-file path, or
authentication token.

## CLI and discovery

```text
agent-workspace-cli identify
agent-workspace-cli notify --title "Build complete" --body "Tests passed" --level info
agent-workspace-cli notify --title "Needs attention" --workspace-id UUID --pane-id UUID --tab-id UUID
```

The CLI discovers the ephemeral authenticated service session in this order:

1. global `--session-file PATH` (a path only; there is deliberately no token flag),
2. `AGENT_WORKSPACE_SESSION_FILE`,
3. on Linux, `$XDG_RUNTIME_DIR/agent-workspace/cli-session.json`,
4. a UID-scoped temporary directory fallback.

The desktop always overwrites an inherited `AGENT_WORKSPACE_SESSION_FILE` before starting its
service. The service creates the record only after binding the local transport and before emitting
readiness, and removes only its own session record on shutdown. On Unix, the containing directory
must be a real current-user-owned `0700` directory and the record must be a real current-user-owned
`0600` regular file; reads reject symlinks and oversized records. macOS uses the UID-scoped temporary
fallback. Windows uses a user-scoped temporary fallback and validates regular-file/no-symlink shape;
ACL hardening for this discovery file is not yet implemented. The separate control named pipe does
have a protected owner/LocalSystem DACL.

Notification targets use explicit flags first, then
`AGENT_WORKSPACE_WORKSPACE_ID`, `AGENT_WORKSPACE_PANE_ID`, and
`AGENT_WORKSPACE_TAB_ID`. If no workspace is supplied, the CLI asks the service for the currently
selected workspace.

## Install, inspect, and remove hooks

```text
agent-workspace-cli hook install codex
agent-workspace-cli hook status codex
agent-workspace-cli hook uninstall codex

agent-workspace-cli hook install claude
agent-workspace-cli hook status claude
agent-workspace-cli hook uninstall claude
```

Installation is explicit and idempotent. A malformed configuration is rejected before any backup,
state, or configuration mutation. Uninstall restores/removes only installer-owned values. If a user
changes a managed value after installation, uninstall reports `conflict` and refuses to overwrite
the edit. Unrelated settings and Claude hook entries are preserved.

### Exact files

Codex installation modifies `~/.codex/config.toml` by setting the official user-level value:

```toml
notify = ["/absolute/path/to/agent-workspace-cli", "hook", "codex"]
```

Codex passes its bounded JSON payload as the final argv value. The adapter extracts only `type` and
`last-assistant-message`.

Claude Code installation modifies `~/.claude/settings.json` by appending one owned command entry to
`hooks.Notification`. The command is the absolute CLI path followed by `hook claude`. Claude passes
bounded JSON on stdin; the adapter extracts only `title`, `message`, and `notification_type`.

Installer state and the first pre-mutation backups live under:

```text
${XDG_STATE_HOME:-~/.local/state}/agent-workspace/hooks/
  codex.json
  codex.backup
  claude.json
  claude.backup
```

State and backups are owner-only and contain no token. The state records the prior Codex `notify`
value and the exact installer-owned Claude entry needed for safe removal.

## Privacy

Hook input is size-bounded and processed in memory. The adapters do not persist raw payloads,
prompts, transcript paths, session IDs, working directories, or full transcripts. Only the sanitized
notification title/body/type fields are published. Control credentials are read from the ephemeral
owner-only session record and are never accepted as a flag or printed in errors.

The implemented formats follow the current official references:

- [Codex configuration reference (`notify` array and JSON payload)](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Claude Code hooks reference (`Notification` command hook and JSON stdin)](https://code.claude.com/docs/en/hooks#notification)

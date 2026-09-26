# Node CLI migration entrypoint

`agent-workspace-node` connects to the opt-in Node service through a private Linux session file.
It provides `identify`, `state snapshot`, Rust-compatible workspace listing and organization,
workspace creation, multiselection, pinning, reordering, and group mutations, remote target and session catalog operations,
read-only agent and public action catalogs, notifications, Codex/Claude hook adapters, and terminal creation and input for isolated-copy runs. The existing
`agent-workspace-cli` remains the production CLI until its complete command set is migrated.

Build both packages, then start the Node server with a fresh private session path:

```sh
pnpm --filter @agent-workspace/cli build
install -d -m 700 "$XDG_RUNTIME_DIR/agent-workspace-node"
AGENT_WORKSPACE_SERVER_TOKEN="$(openssl rand -hex 32)" \
  AGENT_WORKSPACE_NODE_SESSION_FILE="$XDG_RUNTIME_DIR/agent-workspace-node/session.json" \
  pnpm --filter @agent-workspace/server dev
```

The session directory must be owned by the current user with no group or other access. The
server creates the record with mode `0600` after binding its loopback listener and removes only
its own record on normal shutdown. It refuses to replace an existing record; after an abnormal
exit, inspect the old record and service ownership before removing that stale file.

```sh
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" identify
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" state snapshot
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" settings get
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" notification list --window-id UUID
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" notify --title 'Build complete' --body 'Ready to review'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" hook codex '{"type":"agent-turn-complete","last-assistant-message":"Done"}'
printf '%s' '{"notification_type":"permission_prompt","message":"Approval requested"}' | node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" hook claude
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" request settings.update --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" request notification.markRead --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" workspace list
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" workspace organization
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" workspace create --name 'My workspace' --working-directory /tmp
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" workspace pin --workspace-id UUID --pinned true --expected-revision N
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" workspace reorder --workspace-id UUID --destination-index 0 --expected-revision N
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" workspace select-many --workspace-id UUID --workspace-id UUID --focused-workspace-id UUID --expected-revision N
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" workspace close-selected --expected-revision N
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" group create --group-id UUID --name 'My group' --expected-revision N
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" group assign --workspace-id UUID --group-id UUID --expected-revision N
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" layout list
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" layout get --layout-id UUID
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" layout export --layout-id UUID
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" layout save --layout-id UUID --name 'Review layout' --workspace-id UUID --expected-revision N
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" layout apply --layout-id UUID --expected-revision N
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" layout import --layout-id UUID --file ./layout.json --expected-revision N
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote target list
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote target get --target-id UUID
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote target create --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote session list
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote session get --session-id UUID
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote session terminal --session-id UUID
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote session prepare --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote session activate --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote session detach --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote session close --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote host-key scan --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote host-key decide --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" remote tmux discover --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" agent catalog list
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" agent catalog get --session-id UUID
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" request agent.team.create --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" request agent.team.member.create --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" action list --limit 2
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" action invoke --action-id workspace.card.pin --action-version 1 --idempotency-epoch UUID --parameters-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" action cancel --invocation-id UUID --correlation-id UUID
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" sidebar placement list
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" sidebar placement get --window-id UUID
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" textbox list --limit 64
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" textbox get --document-id UUID
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" request sidebar.placement.save --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" request textbox.create --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" request textbox.save --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" request textbox.delete --params-json '{...}'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" terminal create --workspace-id UUID --pane-id UUID --cwd /tmp
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" terminal send --terminal-id UUID --data 'echo ready'
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" pane split --workspace-id UUID --target-pane-id UUID --axis vertical --expected-revision N terminal --cwd /tmp
node apps/cli/dist/bin.mjs --session-file "$XDG_RUNTIME_DIR/agent-workspace-node/session.json" request workspace.select --params-json '{...}'
```

`notify` and the hook adapters target the focused window and its focused workspace by default.
Set `AGENT_WORKSPACE_WINDOW_ID` and `AGENT_WORKSPACE_WORKSPACE_ID` for agents running in another
window or workspace; `notify` also accepts explicit `--window-id` and `--workspace-id`. Optional
pane and tab IDs can be supplied through flags or `AGENT_WORKSPACE_PANE_ID` and
`AGENT_WORKSPACE_TAB_ID`. Hook input is limited to 64 KiB, and only the notification title and
message are forwarded. `hook install|uninstall|status codex|claude` manages its own reversible
hook entries. A private Node session file must be available when an installed hook runs.

Terminal creation accepts `--rows`, `--cols`, `--destination-index`, and a trailing `--command`
with its program and arguments. It reads the current revision unless `--expected-revision` is
supplied. Supply `--expected-revision` with `--idempotency-key` to retry the same request after a
lost response. The CLI
also accepts `AGENT_WORKSPACE_NODE_SESSION_FILE`. It never prints the bearer token.
Workspace creation accepts a trailing `--command` and uses the working directory as its terminal
cwd unless `--terminal-cwd` is supplied. Pinning and reordering require an explicit current
revision. Supply `--idempotency-key` with `--expected-revision` to retry the same create request
after a lost response.
Layout save accepts one or more `--workspace-id` flags in template order. Layout import reads
one Rust-compatible export envelope from `--file` (maximum 256 KiB). Layout writes require an
explicit current revision; keep the same `--idempotency-key` when retrying a lost response.
`workspace close-selected` uses the current multi-selection and can include replacement workspace
options when closing the final workspace. `pane split` accepts `terminal`, `browser`, or
`existing-tab` content. Both use the current revision and support a stable idempotency key for
retries. `action invoke` requires the idempotency epoch advertised by `identify`; the Node
service currently invokes only its three synchronous service-owned actions. Action cancellation
has the Rust `action_not_found` result for these already-completed service actions. Pending
project or desktop action execution and cancellation remain unavailable in Node.
Remote list commands accept `--limit` (1–128, default 128) and `--cursor UUID` for pagination.
Remote mutations take one bounded, strict JSON object matching the shared contract, including
`mutation.idempotencyKey`, `mutation.requestHash`, and `mutation.expectedRevision`. The CLI checks
the server's advertised capability first. Host-key trust requires an explicit prompt ID and the
presented fingerprint from a preceding scan; verify that fingerprint through an independent
channel before choosing `trust`. An explicit opt-in mode can run bounded tmux discovery over
verified SSH. The opt-in activation path can start a local SSH PTY for a prepared session;
`remote session terminal` returns its live terminal ID for the existing terminal attach API.
Credential enrollment and full CLI parity remain pending. The server migrates exact trusted
known-hosts files on the first opt-in remote-mode start when source and working directories are
separate and private.
The action list accepts `--limit` (1–64, default 64) and an opaque `--cursor` from the preceding
page. A cursor can be used once and expires after five minutes. Agent catalog list/get commands
are read-only; audited register, restore, and fork operations use strict `request` contracts and
must be advertised by the running Node service. Fork is currently limited to Codex 0.142.4.
Sidebar placement and TextBox commands operate on an isolated copy. TextBox pages accept `--limit`
(1–64, default 64) and a UUID cursor. Their revision-checked mutations are available through
`request`. With `AGENT_WORKSPACE_EXPERIMENTAL_VOLATILE_SEARCH=1` in Node copy mode, the CLI
also exposes process-local workspace-file search through
`search query|cancel|policy|exclude|forget|rebuild|export-confirm|export --params-json JSON`.
Consent and indexed text expire when the Node process exits; transcript indexing and Rust
encrypted-index persistence remain unavailable.
The `request` command exposes the Node server's supported workspace, tab, pane, group, layout,
and terminal restart mutations with the same strict shared contracts. It requires the exact
advertised capability name and complete revision and idempotency fields. Run `identify` to inspect
the current server capabilities and idempotency epoch before constructing a request.

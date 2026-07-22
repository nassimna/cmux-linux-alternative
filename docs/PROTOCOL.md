# Local control protocol

This is the implemented Milestone 5 protocol reference. It complements the long-term contract in
[the implementation specification](IMPLEMENTATION_SPEC.md); commands described there but absent
here are planned rather than available.

## Transport and framing

- Unix platforms use a per-user local socket; Windows uses a named pipe through `interprocess` with
  a protected owner/LocalSystem-only DACL and remote-client rejection.
- Messages are UTF-8 newline-delimited JSON. Each authentication envelope, request, response, or
  event occupies one frame.
- A complete inbound or outbound frame, including its newline delimiter, is limited to 1 MiB.
- Raw PTY bytes are base64-encoded in JSON. Each decoded output chunk is at most 64 KiB.
- A serialized terminal checkpoint is additionally limited to a 512 KiB JSON wire payload.

The desktop endpoint lookup is a temporary `agent-workspace`-slug detail: an explicit centralized
socket environment override, then `$XDG_RUNTIME_DIR/agent-workspace/control.sock`, then a
user-specific system temporary directory. Windows uses an `agent-workspace-control` pipe name.
These names will change with the public identity.

## Authentication and identification

The first frame must contain the control token:

```json
{ "auth": { "token": "redacted" } }
```

Authentication has a five-second deadline. Failed comparisons are constant-time for equal-length
values and repeated failures are delayed. After authentication, clients identify the service:

```json
{ "id": "request-id", "command": "system.identify", "params": {} }
```

The current protocol version is `1`; clients validate the temporary application identifier and the
complete advertised capability set before exposing the renderer. The service emits one flushed
`service.ready` NDJSON record on stdout only after durable-state bootstrap and endpoint bind.

## Envelopes

Request:

```json
{ "id": "request-id", "command": "system.ping", "params": {} }
```

Success:

```json
{ "id": "request-id", "ok": true, "result": { "pong": true } }
```

Failure:

```json
{
  "id": "request-id",
  "ok": false,
  "error": {
    "code": "invalid_params",
    "message": "The request parameters do not match the command contract",
    "details": {}
  }
}
```

Terminal events use an event name and data payload:

```json
{ "event": "terminal.resized", "data": { "terminalId": "uuid", "rows": 24, "cols": 80 } }
```

## Implemented commands

| Command                       | Purpose                                                                  |
| ----------------------------- | ------------------------------------------------------------------------ |
| `system.identify`             | Return application identity, version, protocol version, and capabilities |
| `system.ping`                 | Confirm that the authenticated connection is responsive                  |
| `terminal.attach`             | Subscribe the client and return checkpoint plus ordered journal state    |
| `terminal.runtimeMetadata`    | Return a bounded TCP listening-port summary for one owned live terminal  |
| `terminal.detach`             | Remove the client's subscription without terminating the PTY             |
| `terminal.send`               | Decode base64 input and write raw bytes to the PTY                       |
| `terminal.resize`             | Resize the PTY in terminal cells                                         |
| `terminal.checkpoint`         | Store an attached client's renderer projection at an accepted sequence   |
| `terminal.restart`            | Replace the selected terminal tab runtime without persisting its command |
| `workspace.list`              | Return the authoritative application snapshot                            |
| `workspace.snapshot`          | Return one workspace inside a revision-matched snapshot                  |
| `workspace.cardSlots.get`     | Return one independent ephemeral card-slot projection                    |
| `workspace.cardSlots.replace` | Revision-check and replace both fixed card slots                         |
| `workspace.create`            | Create and select a workspace with its first terminal                    |
| `workspace.update`            | Update workspace metadata                                                |
| `workspace.select`            | Select a workspace                                                       |
| `workspace.move`              | Move a workspace to an ordered destination                               |
| `workspace.close`             | Close a workspace and its owned terminal sessions                        |
| `pane.split`                  | Split a pane with a new terminal or existing tab                         |
| `pane.focus`                  | Set the selected pane                                                    |
| `pane.resize`                 | Persist a checked split ratio                                            |
| `pane.close`                  | Close a pane under tree invariants                                       |
| `pane.moveTab`                | Move a tab to another pane and index                                     |
| `tab.openTerminal`            | Add a terminal tab to a pane                                             |
| `tab.openBrowser`             | Add a backend-owned browser tab to the requested existing pane           |
| `tab.select`                  | Select a tab and its pane                                                |
| `tab.update`                  | Update a tab title                                                       |
| `tab.move`                    | Reorder or cross-move a tab                                              |
| `tab.close`                   | Close a tab and its terminal if present                                  |
| `settings.get`                | Return shortcuts and notification forwarding policy                      |
| `settings.update`             | Atomically update shortcut overrides and/or notification policy          |
| `settings.resetKey`           | Restore one shortcut to its project default                              |
| `configuration.get`           | Return all typed durable configuration sections and revision             |
| `configuration.update`        | Atomically replace one or more complete sections at an expected revision |
| `window.getState`             | Return the optional checked durable window-state projection              |
| `window.updateState`          | Persist complete checked bounds and native window state                  |
| `notification.list`           | Return paged durable notification history and unread counts              |
| `notification.publish`        | Publish a validated targeted notification                                |
| `notification.markRead`       | Mark one notification read                                               |
| `notification.markUnread`     | Return one notification to unread attention                              |
| `notification.clear`          | Clear one notification, all read records, or all history                 |
| `browser.navigate`            | Validate and set the browser URL before native navigation                |
| `browser.back`                | Revision-check a native history-back request                             |
| `browser.forward`             | Revision-check a native history-forward request                          |
| `browser.reload`              | Revision-check a native reload request                                   |
| `browser.stop`                | Revision-check a native stop-loading request                             |
| `browser.openDevTools`        | Revision-check a native devtools request                                 |

Terminal lifecycle is authoritative: clients create and close PTYs through workspace, pane, and
tab mutations. Production dispatch rejects raw `terminal.create` and `terminal.terminate` requests
with `terminal_lifecycle_managed`, and does not advertise those legacy commands as capabilities.
`terminal.runtimeMetadata` accepts exactly one validated `terminalId`. For an owned live terminal,
the service resolves the service-private root process and its transitive descendants, then returns
the same `terminalId` and at most 16 sorted, unique, non-zero TCP listening ports. Process IDs,
process names, executable paths, socket addresses, and discovery errors are not returned. An exited
terminal or unavailable advisory discovery returns an empty `listeningPorts` array; an unknown
terminal still uses the normal typed terminal-not-found failure.
Implemented events are `terminal.output`, `terminal.resized`,
`terminal.checkpointRequested`, `terminal.exited`, `terminal.resyncRequired`,
`workspace.changed`, `workspace.selectionChanged`, `pane.layoutChanged`, `tab.changed`,
`settings.changed`, `notification.created`, `notification.changed`, and `service.shuttingDown`.
The `card-slots-v1` capability additionally provides `workspace.cardSlots.events` and the targeted
`workspace.cardSlotsChanged` invalidation described below.
Authoritative browser projections additionally emit `browser.changed`. Electron main reports live
view state through the strictly validated internal `browser.observe` command; this command is not
advertised as a public capability.

## Ephemeral workspace card slots

Card slots are a service-authoritative process-local projection, separate from the application
snapshot and SQLite. Version 1 contains exactly nullable agent status and nullable progress. Agent
status is `idle`, `running`, `waiting`, `completed`, or `failed`, with a nullable label. Progress is
either determinate with an integer value from 0 through 100 and a nullable label, or indeterminate
with a required label. Present labels are trimmed, non-empty, control-free, and at most 120 Unicode
scalar values.

Each workspace starts at slot revision zero. `workspace.cardSlots.replace` supplies the expected
revision and both slots, including explicit `null` for absence. A stale revision returns
`revision_conflict`; an equivalent replacement is a no-op with no event. Changed state increments
only the slot revision. Responses do not carry an application revision. The invalidation contains
no slot content:

```json
{
  "event": "workspace.cardSlotsChanged",
  "data": {
    "workspaceId": "10000000-0000-4000-8000-000000000001",
    "slotRevision": 4,
    "reason": "slotsReplaced"
  }
}
```

Desktop clients fetch only `workspace.cardSlots.get` for that workspace. Slot events never require
`workspace.list` or schedule a durable save. Closing a workspace discards its entry; restarting the
service clears all slots. Restart persistence is deferred by
[ADR 0002](decisions/0002-ephemeral-workspace-card-slots.md).

Configuration and window commands are strict Milestone 5 contracts. Configuration schema v2
always returns all eight sections: appearance, terminal, browser, notifications, keyboard
shortcuts, agent integration, updates, and logging; compatible schema-v1 snapshots remain readable,
but expanded density requires v2. Updates use an expected revision and include complete sections
rather than ambiguous partial fields. Window state carries its own safe-integer revision, bounded
coordinates and dimensions, maximized/fullscreen flags, and an optional bounded display identifier.

The protocol guarantees persistence and validation for those sections, not a live runtime owner for
every field. Appearance theme/density, terminal font family/size/scrollback/multiline-paste
protection, and notifications hydrate and apply live through shared renderer/runtime paths. A
configured shell is host-validated before commit and applies to future implicit terminal launches;
explicit commands and existing PTYs are unchanged. Logging level changes apply immediately to
subsequent service events after durable commit and any fallible runtime updates succeed. Browser
profile/privacy and agent-integration controls are persisted but disabled and labeled deferred
until their runtime owners are implemented. Update controls map only to prevalidated desktop feed
roots.

Every successful domain mutation returns a top-level revision equal to the embedded snapshot
revision. Named domain events carry the same revision in the envelope and data. Desktop clients
reject mismatches, refresh after invalidation, and request a full resync after gaps. Mutation
request IDs are replayed per authenticated client through a bounded 256-entry/4 MiB cache so a
retry returns the exact prior response without applying the mutation twice.

## Startup and recovery records

The service emits exactly one bounded startup record. Normal startup uses `service.ready`; an
unusable database uses `service.recoveryRequired` with a typed safe category and no stored user
content. Its desktop-safe projection exposes migration-backup availability as a boolean, including
after migration fails with a secured backup, while the path remains main-process private. Recovery
inspection/export and diagnostic preview/export are separate supervised utility invocations, not
authenticated control commands. The diagnostic preview contains exact entry
names, byte counts, total bytes, redaction count, and creation time; export requires the unchanged
approved preview and writes the allow-listed, redacted bundle as JSON.

## Attachments, queues, and resynchronization

Each client has an attachment set. Terminal events are forwarded only for attached terminal IDs.
The server permits at most 32 concurrent clients, uses a 32-frame response queue and a 16-frame
event queue per client, gives responses write priority, and closes connections idle for 30 minutes.

If the event broadcast or a client's event queue falls behind, the server does not buffer without
bound. It emits `terminal.resyncRequired` when queue space becomes available. The desktop then
reattaches and reconstructs from the latest checkpoint and journal.

## Checkpoints and ordered output

Output sequences increase monotonically. A checkpoint records the last applied sequence, rows,
columns, active normal/alternate buffer, and serialized ANSI projection. The renderer establishes a
checkpoint immediately after attach, then schedules one after five seconds of active output, after
1 MiB of output, after resize, when requested by the service, and during graceful detach where
possible.

The service rejects checkpoints that are ahead of output, older than the accepted checkpoint, too
large, or submitted by a client that is not attached. The runtime keeps a bounded startup journal
before the first checkpoint and a bounded post-checkpoint journal. `reconstructionComplete: false`
explicitly reports that early scrollback was truncated; the PTY may still be live.

The renderer never replays an incomplete raw journal into a reset terminal because it may begin
inside an ANSI escape sequence or UTF-8 code point. It restores only a safe checkpoint when one is
available, otherwise starts with a clean view, then checkpoints that recovery boundary.

## Compatibility workflow

Rust types in `crates/protocol` generate the TypeScript declarations in
`packages/protocol-client/src/generated`. After changing wire types, run:

```sh
pnpm generate:protocol
pnpm test
```

Protocol changes require an RFC, compatibility tests, regenerated declarations, and updates to
this document.

# 0002: Ephemeral workspace card slots

**Status:** Accepted

## Context

Workspace cards need independently refreshed agent status and progress without turning the card
surface into a generic extension system or making rapid advisory updates rewrite the durable
application snapshot. The existing workspace runtime persists every domain mutation to SQLite, so
placing high-frequency presentation state there would couple unrelated control traffic, durable
saves, and `workspace.list` invalidation.

## Decision

The Rust control service owns a process-local card-slot sidecar keyed by authoritative workspace
UUID. The fixed version-1 shape contains exactly two nullable slots:

- `agentStatus`: `{ status, label }`, where `status` is one of `idle`, `running`, `waiting`,
  `completed`, or `failed`, and `label` is nullable.
- `progress`: either `{ mode: "determinate", value, label }`, with integer `value` in `0..=100`
  and nullable `label`, or `{ mode: "indeterminate", label }`, with a required label.

Every label is normalized, non-empty when present, free of Unicode control characters, and at
most 120 Unicode scalar values. Workspace IDs are UUIDs. Every workspace projection has its own
JavaScript-safe integer revision, starting at zero, independent of `ApplicationSnapshot.revision`.

`workspace.cardSlots.get` returns the latest projection for one existing workspace.
`workspace.cardSlots.replace` requires the workspace ID, expected slot revision, and both nullable
fixed slots. It replaces the complete projection. A stale expected revision returns
`revision_conflict`; an identical replacement is an idempotent no-op and emits nothing. A changed
replacement increments only that workspace's slot revision and emits
`workspace.cardSlotsChanged`. Its data contains only `workspaceId`, `slotRevision`, and the closed
reason `slotsReplaced`; it deliberately has no application revision or slot payload. Clients fetch
only the named projection and accept the latest state.

The sidecar and its broadcast channel are bounded by the number of live workspace entries and a
64-event broadcast ring. Per-client control queues retain their existing bounds. The renderer
uses React text nodes only: no HTML, Markdown, URLs, commands, or remote content are interpreted.
The preload remains operation-specific and validates commands, results, and events with strict Zod
schemas generated from or paired with the Rust DTOs.

Entries are discarded when a workspace closes. A service restart constructs an empty sidecar, so
every live workspace returns revision zero with absent slots. Card slots are never serialized into
the application snapshot, configuration, diagnostics, or SQLite. Restart persistence is deferred
until a separate accepted decision defines retention, privacy, migration, and expiry policy.

## Consequences

- Rapid progress/status updates cannot trigger SQLite writes or full `workspace.list` refreshes.
- Renderer reloads retain slots while the service remains alive; service restarts intentionally
  clear them.
- Writers must handle explicit revision conflicts and replace both fixed slots.
- Adding any further slot kind or persistence requires protocol and architecture review rather
  than passing untyped data through this contract.
- Events are invalidations rather than delivery guarantees; the authoritative latest-state fetch
  remains the recovery path after coalescing or queue pressure.

## Alternatives considered

- Storing slots in the durable workspace runtime was rejected because it would cause frequent
  SQLite writes and unrelated application projection invalidations.
- Renderer-owned slots were rejected because producers and multiple clients would have no shared
  authoritative revision or lifecycle.
- A generic named-slot map was rejected because it would admit unbounded or unsafe content and make
  compatibility, accessibility, and security policy open-ended.
- Embedding the new slots in `workspace.list` was rejected because a one-percent progress change
  would require a full workspace snapshot refresh.

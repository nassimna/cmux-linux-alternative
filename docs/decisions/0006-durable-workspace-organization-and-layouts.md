# 0006: Durable workspace organization, selection, and saved layouts

**Status:** Accepted

## Context

M2 adds pinning, groups, multiselect, batch actions, and saved layouts. The current application
snapshot has one ordered workspace vector and one focused workspace. SQLite stores that validated
aggregate as one revisioned JSON value, while `WorkspaceRuntime` serializes mutations, persists the
new aggregate, publishes it, and only then terminates removed PTYs. Treating renderer selection or
group collapse as authoritative would break this ownership model. Rebuilding a workspace from a
layout before full validation could also terminate or duplicate live sessions on an invalid request.

The change affects protocol, durable schema, runtime side effects, and migration behavior, so it
requires an accepted decision under PAR-ARCH-001.

## Decision

### Domain and ordering

`ApplicationState` owns these additional bounded durable values:

- The aggregate permits at most 128 workspaces, 64 panes and 128 tabs per workspace, 1,024 panes and
  2,048 tabs total. Creating or importing beyond a limit fails atomically with `resource_limit`.
- `workspaceSelection`: at most 128 ordered, duplicate-free workspace IDs containing the focused
  `selectedWorkspaceId`. Legacy snapshots migrate to the singleton focused workspace. Closing or
  deleting selected workspaces chooses the deterministic successor, then predecessor, and never
  leaves the nonempty application without one selected and focused workspace.
- `workspacePins`: at most 128 duplicate-free existing workspace IDs. Pinning does not mutate the
  canonical total `workspaces` order.
- `workspaceGroups`: at most 128 records with an opaque UUID, normalized name of 1–80 Unicode
  scalars, closed `collapsed` boolean, and a unique integer order. A workspace belongs to at most one
  group through a complete map of at most 128 `workspaceGroupAssignments`. Deleting a group ungroups its members;
  deleting a workspace removes its pin, selection, and assignment references atomically.
- `savedLayouts`: at most 64 named records with an opaque UUID, normalized name of 1–80 scalars,
  format version, creation/update timestamps, and a bounded layout template. A template contains at
  most 32 workspaces, 128 panes, and 256 tabs and is capped at 256 KiB when serialized.

The canonical workspace vector remains the tie-breaker inside every presentation bucket. The
sidebar presents pinned workspaces first, then groups in group order, then ungrouped workspaces;
each workspace appears exactly once. A pinned workspace keeps its group assignment but is omitted
from the group's visible member list while pinned. Unpinning returns it to that group without an
order jump. Collapse state hides only the group's unpinned member rows and never changes focus or
selection.

Focus and multiselection are deliberately separate. Pointer and keyboard gestures both compute a
complete ordered selection and submit the same authoritative replacement command. The focused
workspace is the selection anchor for range operations. Stale expected revisions fail without an
optimistic durable projection.

### Mutations and contracts

The service advertises optional `workspace-groups-v1` and `saved-layouts-v1` capabilities. Clients
must gate the families independently. Rust DTOs are canonical; generated TypeScript and strict Zod
must reject unknown fields, explicit `null` for optional fields, invalid UUIDs, unsafe integers,
duplicates, dangling IDs, unbounded text, and oversized layout documents.

The workspace organization family exposes typed operations for:

- replacing selection, setting pin state, and batch closing selected workspaces;
- creating, renaming, deleting, reordering, assigning, and collapsing groups; and
- moving a workspace in canonical order.

Every mutation carries the expected application revision and an idempotency UUID. Validation of all
targets and permissions completes before mutation. A successful semantic no-op returns the current
snapshot without incrementing the revision or emitting an event. A successful change increments
the application revision once and emits one bounded invalidation. Batch failure is all-or-nothing
with stable error codes. Existing single-workspace operations remain supported and update the new
organization invariants atomically.

The saved-layout family exposes list/get/save/delete/apply/export/import operations. Human-readable
exports use a strict versioned JSON envelope with no runtime session IDs, PTY output, notification
content, browser storage, secrets, or absolute paths outside explicitly authorized workspace roots.
Import parses and validates the entire bounded document before assigning fresh local IDs. Unknown
format versions and unknown fields fail closed. Import and apply use expected revisions and
idempotency UUIDs.

### Runtime preservation and rollback

Layout apply is planned under the serialized `WorkspaceRuntime` mutation lock in two phases:

1. **Preflight:** parse, authorize paths, validate all domain invariants and resource bounds, match
   existing workspaces/panes/tabs by stable durable IDs, and derive the complete lifecycle delta.
   Failure has no state, SQLite, PTY, browser, or event effect.
2. **Commit:** start only required replacement sessions, bind them into a cloned checked state,
   persist the whole aggregate in the existing immediate transaction, publish once, then terminate
   sessions proven removed. Start or save failure tears down only sessions created by this attempt
   and preserves the previous authoritative state and all prior sessions.

Eligible existing terminal and browser tabs keep their durable tab IDs and runtime ownership.
Layouts never claim to clone process memory. Importing a layout never executes commands; command
launch and destructive removals require the existing policy and an explicit apply/confirmation
path.

### Persistence and compatibility

SQLite schema version 4 records the durable snapshot-shape migration and backup metadata. Version 3
is already assigned to durable idempotency results. Migration
from every supported prior schema is ordered, transactional, and backed up. Missing organization
fields receive safe defaults: singleton selection, no pins/groups/assignments/layouts. Migration
validates the resulting aggregate before commit; interruption or invalid legacy content preserves
the source database and recovery evidence.

A valid v3 snapshot that already exceeds a new count limit is preserved byte-for-byte and enters a
durable `legacyOverLimit` reduction mode; migration never deletes or rejects supported user data.
While in that mode, reads, export, close/delete, and mutations that do not increase any exceeded
dimension remain available, while create/import/apply operations that would increase an exceeded
dimension fail `legacy_limit_reduction_required`. The UI reports exact counts and offers export plus
user-directed reduction. Once every dimension is within v4 limits, the next successful mutation
atomically clears the mode and it cannot be re-entered. Migration and property tests cover every
over-limit dimension and prove no implicit truncation.

The top-level control protocol framing remains version 1. The two capability names identify the new
semantic families as required by ADR 0004. Older clients continue using the legacy workspace family
and safely ignore additional snapshot fields only where their validators allow them; otherwise the
desktop requests the capability-specific projection. Older services remain usable with organization
and layout UI hidden.

## Consequences

- Selection, pinning, groups, collapse, order, and layouts have one checked authoritative owner and
  survive restart.
- Pointer and keyboard paths cannot diverge into renderer-only selection state.
- Invalid layouts cannot create, terminate, or rebind PTYs or browser views.
- Aggregate persistence keeps cross-feature mutations atomic, at the cost of rewriting one bounded
  snapshot for organization changes.
- Independent capability families allow mixed-version fallback and focused future versioning.
- Property, migration, recovery, protocol parity, runtime failure, keyboard, accessibility, visual,
  and E2E tests are release requirements for M2.

## Alternatives considered

- Renderer-owned multiselection was rejected because refresh, restart, and competing clients would
  disagree about batch targets.
- Storing separate group and layout tables was rejected for M2 because it would require a second
  cross-table transaction protocol beside the already atomic aggregate snapshot.
- Reordering the canonical vector when pinning was rejected because unpinning would lose the user's
  stable group-relative position.
- Applying layouts through a sequence of existing create/close calls was rejected because partial
  failure could destroy live sessions.
- Persisting runtime session IDs or terminal contents in layout exports was rejected because those
  values are ephemeral, private, and not portable.

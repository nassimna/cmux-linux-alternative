# 0007: Multi-window and tab transfer ownership

**Status:** Accepted

## Context

M3 requires duplicate, move, reopen, and detach tab actions plus multiple desktop windows. Today the
domain guarantees globally unique tab and runtime identities, and `WorkspaceRuntime` can preserve a
terminal session across a checked aggregate rearrangement. Electron, however, assumes one
`BrowserWindow`, one renderer binding, one bounds record, and one `BrowserViewManager`. A renderer-
only window map would not own durable placement or native views and could duplicate a PTY attachment
or `WebContentsView` during races and crashes.

The change crosses persistence, protocol, runtime, Electron ownership, IPC authorization, and crash
recovery, so PAR-ARCH-001 requires an accepted decision before implementation.

## Decision

### Durable topology

The service advertises optional `multi-window-v1` only after the complete family is available.
`ApplicationState` owns at most 16 `WindowPlacement` records. Each record has an opaque UUID, a
bounded user label, an ordered nonempty list of workspace IDs, a focused workspace ID, and a closed
hosting state (`hosted`, `unhosted`, or `closing`). Each workspace belongs to exactly one placement.
The initial migration creates one placement containing all existing workspaces.

Per-window display bounds are stored by stable window ID in SQLite schema version 5. Bounds are
advisory desktop state, validated against a live display before use, and never override the service's
topology. Migration copies the former singleton bounds to the initial placement. Missing displays,
corrupt bounds, or unsupported scale factors fall back to the existing visible safe default.

The service also owns at most 100 redacted recently-closed records retained for 30 days. Expired
records are removed before capacity pruning; overflow removes the oldest closure time/ID
deterministically. Each record has an opaque ID, item kind, prior durable tab/workspace identity,
content kind, title of at most 160 scalars, closure time, and one strict restore descriptor capped at
8 KiB. Terminal descriptors contain only authorized root identity, root-relative cwd, and dimensions.
Browser descriptors contain only a safe HTTP/HTTPS URL of at most 2,048 scalars with userinfo, query,
and fragment removed. Records contain no commands, terminal output, browser history/storage,
credentials, secret-bearing URLs, or process-memory claim. M3 exposes typed tab reopen. A single
record cannot honestly reconstruct a multi-pane/multi-tab workspace, so workspace-level closed
records and typed workspace reopen are reserved for M8 alongside search and the full sidebar
history surface.

### Advanced tab semantics

- **Move/detach:** move the same durable tab ID and the same terminal runtime or browser session ID
  to a target pane/workspace/window. A move never creates or terminates the underlying PTY. Detach is
  a move to a newly created placement/window.
- **Duplicate:** clone only bounded durable launch/browser metadata into a new tab with fresh tab and
  session identities. It launches a new PTY or creates a new isolated browser session and never
  claims to clone process memory, cookies, or a native view.
- **Close:** atomically removes the tab and appends one bounded redacted closed record before runtime
  cleanup. Existing final-pane/workspace replacement invariants still apply.
- **Reopen:** consumes or marks the closed record restored and creates fresh runtime identity from its
  authorized descriptor. It does not resurrect a dead process or browser renderer. Unsupported or
  no-longer-authorized descriptors fail without state or runtime effects.

Every mutation carries expected application/window revisions, the current server-issued idempotency
epoch, and an idempotency UUID. All targets,
limits, policies, and hosting eligibility are checked before durable change. The service returns the
exact persisted result on replay, including after caller loss or restart, while the ticket is valid.
After result retention, a compact request-hash tombstone remains until the epoch rotates. Rotation
invalidates the entire prior epoch; a replay then returns `idempotency_expired` and never executes as
new work. A semantic no-op emits no event.

### Desktop window registry and privileged routing

Electron main owns a `WindowRegistry` keyed by service-issued window ID. Each entry contains exactly
one live `BrowserWindow`, renderer generation, fixed preload binding, window-state controller,
terminal attachment set, and browser-view manager. Global IPC handlers are registered once and
authorize each request by the event sender's `webContents.id`, main-frame identity, registry
generation, advertised capability, and service-confirmed window placement. A renderer cannot name
another window to gain authority; cross-window operations are typed service commands.

PAR-301/M3 implements the private authenticated desktop-provider substrate needed for window
creation and hosting: registration, leases, target arbitration, acknowledgements, cancellation, and
disconnect behavior. M4 reuses and extends this substrate for public action discovery/reverse
execution; it does not introduce provider ownership after multi-window. The service never
impersonates an Electron-owned action.

### Transfer transaction and native ownership

Cross-window movement follows this ordered transaction:

1. Under the serialized service/runtime mutation lock, validate revisions, source ownership, target
   placement, provider lease, capacity, and policy; derive the entire checked aggregate and lifecycle
   delta. No desktop or PTY effect occurs.
2. Persist the aggregate and idempotency result atomically, publish one bounded transfer event, and
   prove the terminal lifecycle delta contains neither creation nor termination for a moved live
   terminal.
3. Electron consumes the committed event under a per-resource transfer mutex and monotonic epoch.
   The source becomes hidden/detached before the target becomes visible/attached. Renderer terminal
   subscription detach and attach remain serialized.
4. Browser transfer recreates one replacement `WebContentsView` in the target manager from the
   authoritative browser-session state, then destroys the source view. Direct native-view reparenting
   is forbidden until separately qualified. At no point may two views be visible or input-enabled for
   one browser session.

If a source or target disappears before durable commit, the command fails with no state change.
After commit, loss triggers deterministic rehome to the lowest ordered eligible surviving placement.
With no eligible host, topology remains durable as `unhosted`; native views are destroyed and can be
recreated later. Window close uses explicit close/rehome policy and never silently destroys durable
workspaces. Renderer crash replaces only that registry generation; stale IPC and transfer
acknowledgements are denied.

The invariant is: every workspace, tab, runtime session, browser session, renderer attachment, and
native view has at most one authoritative owner; every committed item is hosted, explicitly
unhosted/rehome-pending, or represented by a closed record.

### Contracts, bounds, and compatibility

Rust defines strict DTOs and generated TypeScript/Zod validates every untrusted response/event.
Operations cover window list/create/close/focus, tab duplicate/move/detach/close/reopen, and closed
record list/get. Events are bounded invalidations carrying IDs, revisions, epoch, and a closed
reason—not snapshots or content. Stable errors distinguish stale revisions, missing sources/targets,
ineligible providers, unhosted targets, transfer conflict, canceled transfer, policy denial, and
resource limits.

Existing single-window commands remain usable only while topology contains the one migrated default
placement. A new desktop connection is bound to one service-issued placement and receives only that
placement's legacy projection. Once more than one placement exists, unscoped legacy mutations fail
`placement_required`; legacy desktop clients cannot host the multi-window topology. New desktop and
renderer UI is hidden unless `multi-window-v1` is advertised. The top-level protocol framing remains
version 1 under ADR 0004; incompatible later semantics require a new capability family.

## Consequences

- Terminal moves preserve one PTY identity and browser moves preserve one logical browser session
  while native views remain main-owned and single-visible.
- Window close/crash has deterministic rehome or unhosted behavior instead of orphaned views.
- Privileged IPC scales to multiple renderers without trusting caller-supplied window authority.
- Duplicate and reopen are honest restart operations, not process-memory cloning.
- SQLite schema 5, migration/recovery, property/race tests, multi-window Electron E2E, browser
  privilege tests, accessibility/keyboard tests, leak checks, bounds tests, and packaged smoke are
  required before M3 qualification.

## Alternatives considered

- Keeping window placement only in Electron was rejected because the service could not validate
  ownership, recover crashes, or coordinate clients.
- Sharing global IPC handlers by replacing the current window binding was rejected because two live
  renderers would race and stale senders could retain privilege.
- Directly reparenting a live `WebContentsView` was rejected until Electron behavior is separately
  qualified; recreate-from-authoritative-state has clearer ownership and cleanup.
- Sequential close-then-open tab moves were rejected because failure could lose a live session.
- Treating duplicate/reopen as a runtime clone was rejected because PTYs and browser renderer memory
  are not safely clonable or portable.

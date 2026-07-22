# 0008: Public actions and desktop provider leases

**Status:** Accepted

## Context

M4 exposes stable actions to the palette, shortcuts, authenticated local clients, and CLI. Some
actions are service-owned mutations; others require Electron-owned windows, native views, dialogs,
or operating-system integration. The existing renderer registry is a local UX adapter, not a public
authority. The current authenticated socket replay cache is per connection and cannot coordinate an
Electron action across caller loss, provider disconnect, or service restart.

The action API and reverse execution path expand protocol, authorization, persistence, and desktop
trust boundaries. PAR-ARCH-001 therefore requires an accepted decision.

## Decision

### Action contracts and ownership

The service defines optional `actions-v1`, but does not advertise it until the remaining M4
qualification gates are complete. It owns a closed, versioned registry of Tier A
`ActionDefinition` records. Each bounded record contains a stable namespaced action ID, action
version, localized-title key, optional trusted dynamic display title/default logical shortcut,
category, owner (`service` or `desktop`), parameter/result schema versions, authorization class,
interaction class, optional required desktop capability, and limits. Dynamic text/shortcuts are
strictly bounded and valid only as registry metadata; they grant no execution authority, and clients
apply the shared physical-shortcut conflict policy before installing them.
Discovery is content-free and paginated; it does not expose commands, paths, browser contents, or
runtime secrets.

Version 1 permits at most 256 definitions of 8 KiB each. Discovery pages contain at most 64 records
and cursors expire after five minutes. Invocation parameters and results are each capped at 64 KiB;
action-specific schemas may set lower bounds. There are at most 256 nonterminal invocations globally
and 32 per provider. Overflow fails `resource_limit` without enqueueing.

SQLite schema version 6 adds bounded durable invocation/start-claim state and idempotency epochs;
schema version 7 adds proof-free desktop-provider recovery and service fencing.
The M3 provider registration/lease substrate remains authoritative; M4 adds public action records and
reverse execution without a second provider registry.

`action.list`, `action.invoke`, `action.cancel`, and bounded lifecycle invalidations use strict Rust
DTOs with generated TypeScript/Zod parity. Invocation carries exact action/version, typed bounded
parameters, optional service-issued target, the current server-issued idempotency epoch, an
idempotency UUID, and a correlation UUID. Unknown
fields, `null` ambiguity, stale versions/revisions, malformed targets, oversized values, and
unauthorized actions fail closed with stable codes.

Service-owned actions validate all targets and policy before mutation and atomically persist the
state change plus exact result through the namespaced durable idempotency mechanism. Replays return
the exact original terminal result after response loss or restart. A semantic no-op emits no event.

The renderer command registry and workspace-card actions become adapters over the same stable
definitions. Every stable Tier A UI action has one public ID unless it is documented as an
interaction-only/security exception. Palette, shortcut, context menu, card, CLI, and direct socket
paths submit the same typed invocation and do not invent success locally.

The initial production registry is intentionally bounded. The following matrix is authoritative for
the remaining workspace-card UI entries; an exception means the renderer ID is not discoverable or
invocable through `actions-v1` until the named interaction/policy contract exists.

| UI action IDs                                                                                                                        | M4 public status               | Reason                                                                                                                                          |
| ------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.card.pin`, `workspace.group.rename`, `workspace.group.collapse`                                                           | Service-owned v1               | Headless authoritative mutations with epoch-scoped atomic result replay.                                                                        |
| `desktop.window.focus`                                                                                                               | Desktop-owned v1               | Requires the exact native window provider and generation.                                                                                       |
| `workspace.card.select`, `workspace.card.attention`                                                                                  | Interaction-only exception     | Changes transient focus/attention acknowledgement and requires explicit caller/UI-presence policy.                                              |
| `workspace.card.reorder`, `workspace.card.move.up`, `workspace.card.move.down`, `workspace.group.move`, `workspace.card.assignGroup` | Interaction-only exception     | Drag/order semantics need an explicit expected-order contract; `assignGroup` must also migrate to a canonical lowercase public ID.              |
| `workspace.card.close`, `workspace.card.closeSelected`, `workspace.group.delete`                                                     | Confirmation exception         | Destructive scope and replacement behavior require a typed confirmation token; `closeSelected` must migrate to a canonical lowercase public ID. |
| `workspace.card.rename`, `workspace.group.create`                                                                                    | Interaction-only exception     | User text entry remains a UI flow until its validation and confirmation affordance is represented in the public schema.                         |
| `workspace.card.color`, `workspace.card.color.custom`                                                                                | Interaction-only exception     | These IDs open a picker and do not describe a durable mutation.                                                                                 |
| `workspace.card.color.set`, `workspace.card.color.clear`                                                                             | Schema exception               | Durable candidates, but deferred until one canonical bounded color schema replaces the renderer-only variants.                                  |
| `workspace.card.duplicate`                                                                                                           | Policy exception               | May create runtime/terminal resources and needs an explicit launch and rollback policy.                                                         |
| `workspace.layout.save`, `workspace.layout.apply`, `workspace.layout.delete`                                                         | Confirmation exception         | Multi-workspace effects require typed preview/confirmation and stale-revision behavior.                                                         |
| `workspace.layout.import`, `workspace.layout.export`                                                                                 | Security/interaction exception | File chooser, path disclosure, overwrite, and untrusted-document validation stay behind the desktop boundary.                                   |

The application command registry is covered by the same rule. These are the explicit v1 mappings
and exceptions for every remaining stable command ID:

| UI command IDs                                                                                                                      | M4 public status                          | Reason                                                                                                                                                                                                                              |
| ----------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `workspace.new`                                                                                                                     | Security/interaction exception            | The current command is a trusted native directory-picker flow. The existing typed `workspace.create` socket method remains the headless API; the picker command is not remotely invocable.                                          |
| `terminal.new`, `pane.splitRight`, `pane.splitDown`                                                                                 | Launch-policy exception                   | These create a runtime process and require one canonical selected-pane, launch-environment, rollback, and confirmation policy before an action facade can be enabled. Existing typed terminal/pane socket methods remain available. |
| `tab.close`                                                                                                                         | Confirmation exception                    | Destructive scope and selected-tab replacement require a typed confirmation token.                                                                                                                                                  |
| `tab.duplicate`                                                                                                                     | Policy exception                          | Runtime duplication requires an explicit launch/rollback policy; the M3 typed lifecycle command remains available.                                                                                                                  |
| `tab.moveToWindow`, `tab.detach`                                                                                                    | Interaction exception                     | Destination selection and new-window placement are trusted UI flows; the M3 exact-target lifecycle commands remain the headless API.                                                                                                |
| `tab.reopen`                                                                                                                        | Policy exception                          | Reopening can recreate a terminal runtime and therefore shares the explicit launch/rollback policy requirement.                                                                                                                     |
| `window.new`, `window.close`                                                                                                        | Native interaction/confirmation exception | Creation needs trusted display/parent placement and close needs a typed close-policy confirmation.                                                                                                                                  |
| `window.focusNext`, `focusHistory.back`, `focusHistory.forward`                                                                     | Interaction-only exception                | These mutate transient focus order/history and require a live caller-window policy. Exact `desktop.window.focus` is the public native focus primitive.                                                                              |
| `sidebar.toggle`, `commandPalette.toggle`, `terminal.search`, `notifications.toggle`, `notifications.latestUnread`, `settings.open` | Interaction-only exception                | These only expose or focus ephemeral renderer UI and do not represent durable headless mutations.                                                                                                                                   |
| `browser.openSplit`, `browser.back`, `browser.forward`, `browser.reload`, `browser.stop`, `browser.openDevTools`                    | Security exception                        | Browser ownership, origin, permission, DevTools, and content boundaries are defined and capability-gated by M5/ADR 0010 rather than generic M4 actions.                                                                             |

### Provider registration and authorization

Only Electron main may register a desktop provider. Registration is authenticated with a
single-use, owner-only bootstrap proof delivered out of band by the desktop/service supervisor; a
normal authenticated CLI connection cannot claim provider scope. The service issues an opaque
provider ID, provider epoch, capability set, owned service window IDs and generations, and an
expiring lease. Heartbeats renew only the exact active identity. All secrets remain outside renderer
state, logs, diagnostics, and command-line arguments.

An eligible provider has an unexpired lease, the required capability, exact current ownership of
the service-issued target window/generation, and is not draining. An explicit target selects only
its eligible provider or fails. Without an explicit target, the service deterministically chooses
the most recently focused eligible window, breaking ties by provider registration sequence. Exactly
one provider is leased for an invocation.

At most 16 providers may be registered. Leases last 15 seconds and require a heartbeat at least every
five seconds; the restart recovery window is 30 seconds. Each provider reverse queue holds at most 32
requests. A full queue fails `provider_backpressure` and never spills to the event channel.

Registration and heartbeat atomically persist the provider ID, instance ID, epoch, lease ID,
registration sequence, a canonical SHA-256 digest of the sorted capability/window-claim set, a
fresh control-service fence, and an absolute recovery deadline. The bootstrap proof is never
persisted. Cross-service recovery requires the new service's fresh owner-only bootstrap proof plus
the exact instance and capability/claim digest, atomically rotates the service fence, and rebuilds
only nonterminal invocations with the exact provider/epoch/lease identity. Mismatch, expiry, or
replay fails closed; unregister, revocation, and recovery expiry delete the row. Poll, start, and
nonterminal acknowledgement validate the current service fence, so a prior service process cannot
continue consuming reverse requests after recovery.

### Durable reverse execution state machine

For a desktop-owned action the service persists a bounded invocation record before dispatch. Its
state machine is:

`accepted -> leased -> dispatched -> startClaimed -> startGranted -> acknowledged | failed | canceled | expired`.

The reverse request contains provider lease ID/epoch, invocation ID, attempt epoch, action
ID/version, exact target window/generation, and typed parameters. The acknowledgement must match all
correlation fields and a strict result schema. Before any native effect, Electron submits a start
claim for the exact attempt. The service atomically persists either `startGranted` or cancellation;
Electron must not begin until it receives the matching grant. The service accepts and persists one
terminal outcome only; duplicates return that outcome and late, mismatched, or post-cancel
acknowledgements are rejected and audited.

Caller loss, explicit cancel, timeout, provider disconnect, lease expiry, target-window generation
change, and service shutdown converge on one durable terminal result. Before `startGranted`, cancel
wins atomically and the request is withdrawn. After the matching grant, cancellation returns a stable
`cancellation_not_guaranteed` outcome unless the provider proves the effect stopped. The service
never performs or impersonates Electron-owned execution.

Provider queues and full invocation results are fixed-size and age-bounded. Compact tombstones retain
the idempotency key, epoch, request hash, and terminal code after result eviction. Tombstones are
bounded by 65,536 entries or 365 days; pruning rotates the server-issued epoch, making all prior-epoch
requests return `idempotency_expired` rather than execute again. Control response
traffic keeps priority over events; saturation yields stable backpressure/resync errors rather than
unbounded work. Restart reconciles nonterminal records to an explicit interrupted/expired outcome
unless a matching provider re-registers within the bounded recovery window using the fresh
service bootstrap proof and exact durable identity digest. A successful recovery preserves the
original provider/epoch/lease correlation and terminal replay contract.
Full results retain at most 4,096 entries for 30 days. Action execution defaults to 30 seconds and
may declare up to five minutes; expiry follows the same atomic cancel-versus-start-grant rules.

### CLI, audit, and compatibility

CLI adds `action list`, `action invoke`, and `action cancel`. Machine output is one versioned JSON
envelope. Stable exit classes cover usage/validation, unavailable provider, authorization/policy
denial, conflict, cancellation/timeout, and transport/service failure. The CLI retains owner-only
session discovery and never accepts a control-token flag.

Structured audit records contain action/version, opaque invocation/correlation/caller/provider/
window IDs, authorization decision, lifecycle timestamps, terminal code, sizes, and redaction
counts. They exclude credentials, control tokens, terminal/browser content, raw parameter values,
private URLs, command text, and absolute paths. Diagnostics reuse recursive redaction before export.

Older services remain usable with public action UI/CLI hidden. The top-level framing remains version
1 under ADR 0004; incompatible semantics require a new action capability version.

## Consequences

- One typed registry connects UI and public invocation without making the renderer authoritative.
- Service and desktop actions have explicit, durable idempotency and cancellation behavior.
- Arbitrary authenticated clients cannot become privileged Electron providers.
- Multi-window arbitration selects one exact window/provider and rejects stale generations.
- Protocol parity, authz/backpressure/replay, provider race, CLI contract, audit/redaction, palette,
  shortcut, and E2E tests are required before M4 qualification.

## Alternatives considered

- Exposing renderer callbacks as the public registry was rejected because the renderer is
  untrusted, ephemeral, and cannot authorize native effects.
- Letting any token-authenticated client register as a provider was rejected as a privilege
  escalation.
- Generic reverse JSON/IPC execution was rejected because it would bypass fixed schemas and preload
  least privilege.
- Retrying desktop actions against multiple providers was rejected because native effects may not
  be idempotent.
- Keeping invocation results only in memory was rejected because response loss and restart would
  make exactly-once completion unknowable.

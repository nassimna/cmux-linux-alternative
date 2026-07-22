# M8 right-sidebar validation

Status: M8-AC-01 through M8-AC-04 are implemented, independently re-reviewed clean, and the
packaged M8 runtime gate passes. Repository-wide exact-candidate qualification remains pending, so
this record does not claim release qualification.

## Implemented boundary

- `crates/protocol/src/sidebar_content.rs` defines exactly eight fixed surfaces: TextBox, Vault,
  Task Manager, Files, Markdown, Diff, Search, and Recently Closed.
- `crates/storage/src/sidebar_content.rs`, `crates/control-server/src/sidebar_content.rs`, and
  `crates/content-index/src/lib.rs` own durable placement/content state, opaque path authorization,
  safe bounded reads/Markdown/diffs, a local consented encrypted index, retention, per-source
  exclusion, forget/rebuild, bounded source-scoped export, and authoritative agent/remote tasks.
- `apps/desktop/src/main/desktop-ipc.ts` and `apps/desktop/src/preload/index.ts` expose fixed typed
  operations. Destructive task actions and index export require native main-owned confirmation.
- `apps/desktop/src/renderer/src/sidebar/RightSidebar.tsx` owns the resizable keyboard-accessible
  projection. A persisted titlebar toggle leaves the tools dock closed on a fresh profile and
  restores it explicitly. `apps/desktop/e2e/sidebar-m8.spec.mjs` covers the packaged toggle,
  keyboard, zoom, restore, and accessibility flow.

## Focused evidence

The focused development runs reported:

| Boundary                                   | Result     |
| ------------------------------------------ | ---------- |
| Rust sidebar protocol tests                | 6 passed   |
| Generated binding checks                   | 485 passed |
| Content-index retention focus              | 1 passed   |
| Control-server sidebar tests               | 8 passed   |
| Protocol-client sidebar schemas            | 8 passed   |
| Desktop export/IPC plus RightSidebar focus | 41 passed  |
| Desktop typecheck                          | Passed     |
| RightSidebar focused renderer suite        | 5 passed   |
| Runtime capability advertisement           | 1 passed   |
| Canonical unavailable-preview focus        | 1 passed   |
| Packaged M8 Electron flows (`test:m8`)     | 4 passed   |

The high-only follow-up review confirmed canonical unavailable-preview metadata, the bounded 400%
zoom overlay, exact transcript consent before `includeTurns`, the transcript exclusion/retention/
rebuild/forget packaged flow, and bounded root-list requests. No critical/high finding remains.

The packaged gate ran on 2026-07-21 with a display and the KDE Secret Service compatibility
provider. Its four flows cover path-authorized workspace search, exact recently-closed reopen,
authoritative native-confirmed task termination, 200%/400% keyboard/zoom/accessibility restoration,
and the transcript privacy lifecycle. Retained screenshots are in
[`evidence/m8`](evidence/m8/).

## Pending qualification

Visual and automated accessibility gates pass. The remaining repository-wide blockers are recorded
in the [final-candidate audit](2026-07-21-m0-m8-final-candidate-audit.md) and are not implied by the
focused results above.

# cmux pinned capability inventory

**Audit date:** 2026-07-21  
**Upstream baseline:** `6849b9351c4a776680ffef34a0323c15e88ea0e7`; official documentation through `0.64.19`  
**Status vocabulary:** Supported, Partial, Missing, Out of scope

Evidence IDs resolve through [`CMUX_CLEAN_ROOM_EVIDENCE.md`](CMUX_CLEAN_ROOM_EVIDENCE.md). Local
status means evidenced in this repository; it is not a compatibility or release claim.

## Workspace, card, and navigation capabilities

| Capability                                                  | Upstream evidence      | Local status | Local evidence or gap                                             | Target        |
| ----------------------------------------------------------- | ---------------------- | ------------ | ----------------------------------------------------------------- | ------------- |
| Workspace create, rename, reorder, duplicate, select, close | UP-001, UP-002         | Supported    | Core/runtime protocol and `WorkspaceShell` flows                  | M0 regression |
| Recursive horizontal/vertical panes                         | UP-001, UP-002         | Supported    | Core split tree, runtime, renderer                                | M0 regression |
| Terminal and browser tabs within panes                      | UP-001, UP-002         | Supported    | Typed tab model and renderer                                      | M0 regression |
| Rich card path, branch, process, ports, color, name         | UP-001, UP-011         | Supported    | Runtime metadata and current card renderer                        | M1            |
| PR status and linked PR action                              | UP-001, UP-011         | Supported    | Bounded `pullRequest` slot and stable HTTPS action                | M1            |
| Agent status and progress card slots                        | UP-001                 | Supported    | `card-slots-v1`, ADR 0002                                         | M1            |
| Custom metadata, Markdown, log tail, task, SSH, media slots | UP-001, UP-005, UP-011 | Supported    | Strict bounded v2 DTOs and renderers for all nine slot kinds      | M1            |
| Notification/attention rings and exact target navigation    | UP-001                 | Supported    | Five-state authoritative attention projection and exact jump/read | M1            |
| Dense, normal, expanded card layouts                        | UP-001                 | Supported    | Versioned density preference and progressive card composition     | M1            |
| Stable card action IDs and overflow parity                  | UP-007, UP-009         | Supported    | Stable card action IDs shared by primary and overflow paths       | M1/M4         |
| Workspace pinning                                           | UP-003, UP-011         | Supported    | Durable domain/store/runtime invariant and sidebar interaction    | M2            |
| Sidebar multiselect and batch actions                       | UP-003                 | Supported    | Authoritative selection plus pointer/keyboard batch-close paths   | M2            |
| Collapsible persistent groups                               | UP-003                 | Supported    | Durable ordered groups, assignments, collapse, CLI, and UI        | M2            |
| Saved layouts with atomic apply/rollback                    | UP-010, UP-011         | Supported    | Strict portable layouts with transactional preflight/apply        | M2            |
| Recently focused back/forward navigation                    | UP-011                 | Supported    | Bounded durable focus history with exact-target back/forward UI   | M3            |
| Recently closed and reopen to original anchor               | UP-011                 | Supported    | Bounded closed records, restore descriptors, and fresh-ID reopen  | M3/M8         |

## Window, action, browser, and automation capabilities

| Capability                                             | Upstream evidence | Local status | Local evidence or gap                                                       | Target           |
| ------------------------------------------------------ | ----------------- | ------------ | --------------------------------------------------------------------------- | ---------------- |
| Isolated in-app browser view                           | UP-001            | Supported    | Electron-owned `WebContentsView` manager and security tests                 | M0 regression    |
| Browser navigation, focus, history, reload, devtools   | UP-001, UP-004    | Supported    | Typed service/main/preload operations                                       | M0/M5 regression |
| Duplicate/move/detach/reopen advanced tab actions      | UP-001, UP-007    | Supported    | Typed M3 actions with exact ownership transfer and packaged keyboard flows  | M3               |
| Multiple windows and cross-window movement             | UP-001, UP-007    | Supported    | Authoritative window registry, generations, and packaged transfer coverage  | M3               |
| Bounds restoration and deterministic crash rehome      | UP-010            | Supported    | Durable bounds plus fenced close/crash reconciliation and rehome            | M3               |
| Searchable command palette                             | UP-009, UP-011    | Supported    | Renderer command palette for current commands                               | M0 regression    |
| Stable public action registry and discovery            | UP-001, UP-009    | Supported    | Versioned `actions-v1` registry, palette, CLI discovery, and replay         | M4               |
| Authenticated CLI/socket domain operations             | UP-001            | Supported    | Owner-only authenticated sockets and strict typed Tier A CLI commands       | M4               |
| Project custom commands                                | UP-008, UP-009    | Supported    | Allowlisted literal-argv execution with native confirmation and redaction   | M4               |
| Desktop provider leases/reverse execution              | UP-004            | Supported    | Fenced leases, arbitration, exact target routing, cancellation, and replay  | M4/M5            |
| Browser DOM query/input/wait/snapshot/screenshot       | UP-004            | Supported    | Bounded `browser-automation-v1` operations and screenshot handles           | M5               |
| Browser session data, dialogs, frames, downloads, logs | UP-004            | Partial      | Addressable isolated sessions and enforced policies; no broad introspection | M5               |
| Hostile-page automation isolation and cleanup          | UP-004            | Supported    | Packaged hostile-page, lifecycle, provider-loss, and native-window races    | M5               |

## Notifications, find, settings, and baseline controls

| Capability                                                     | Upstream evidence | Local status | Local evidence or gap                                                                                                                                                             | Target           |
| -------------------------------------------------------------- | ----------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------------- |
| Notification history panel and unread count                    | UP-001, UP-007    | Supported    | Service-owned bounded notification history and renderer panel                                                                                                                     | M0 regression    |
| Jump to latest unread and explicit read/unread controls        | UP-001, UP-007    | Supported    | Exact workspace/pane/tab navigation and revisioned notification mutation                                                                                                          | M0/M1 regression |
| Terminal-local find with next/previous keyboard paths          | UP-007            | Supported    | xterm search tool and documented shortcuts                                                                                                                                        | M0 regression    |
| Directory/global find                                          | UP-007, UP-011    | Supported    | Consented local, path-authorized, bounded source index and Search surface; see [`validation/m8-sidebar-surfaces.md`](validation/m8-sidebar-surfaces.md)                           | M8               |
| Configurable workspace/pane/tab/browser/notification shortcuts | UP-007, UP-008    | Supported    | Typed shortcut registry, conflicts, persistence, palette display                                                                                                                  | M0 regression    |
| Appearance, terminal, notification, logging, update settings   | UP-008            | Supported    | Versioned config, strict service update, renderer settings                                                                                                                        | M0 regression    |
| Browser privacy/profile preferences                            | UP-008            | Partial      | Typed fields persist; unsupported controls remain disabled and have no runtime owner                                                                                              | M5               |
| Sidebar mode/focus settings                                    | UP-007, UP-008    | Supported    | Durable eight-surface registry, placement/width bounds, keyboard focus owner, zoom and a11y harness; see [`validation/m8-sidebar-surfaces.md`](validation/m8-sidebar-surfaces.md) | M8               |
| Terminal copy/paste/font/clear-scrollback keyboard controls    | UP-007            | Supported    | xterm interaction and multiline-paste security coverage                                                                                                                           | M0 regression    |
| Window create/reopen/config reload shortcuts                   | UP-007            | Partial      | Settings/reload/quit exist; multi-window create and broad reopen absent                                                                                                           | M3               |

## Restore, agents, remote, and productivity capabilities

| Capability                                           | Upstream evidence      | Local status | Local evidence or gap                                                                                                                                       | Target        |
| ---------------------------------------------------- | ---------------------- | ------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| Workspace/layout/settings/browser restoration        | UP-010                 | Supported    | SQLite/config/window/browser projections and recovery                                                                                                       | M0 regression |
| Honest PTY reconstruction without memory cloning     | UP-010                 | Supported    | New PTY on service loss; renderer reattach to live service                                                                                                  | M0/M6         |
| Tool-supported agent resume catalog                  | UP-010                 | Supported    | Durable catalog and explicit live/tool/layout/unavailable restore outcomes; see [`validation/m6-agent-sessions.md`](validation/m6-agent-sessions.md)        | M6            |
| Fork conversation with provenance                    | UP-010, UP-011         | Supported    | Fresh durable identity with immutable source/artifact provenance; see [`validation/m6-agent-sessions.md`](validation/m6-agent-sessions.md)                  | M6            |
| Agent teams and native subagent splits               | UP-001                 | Supported    | Durable team/member graph and exact workspace/pane/tab/session attention routing                                                                            | M6            |
| Agent hibernation with confirmation policy           | UP-011                 | Supported    | Resumability-aware disposition and native-confirmed destructive paths                                                                                       | M6            |
| SSH workspace with host-key and reconnect states     | UP-005                 | Supported    | Native host-key trust, credential rotation, exact identity, and reconnect state; see [`validation/m7-remote-sessions.md`](validation/m7-remote-sessions.md) | M7            |
| Remote browser routing and local notification relay  | UP-005                 | Missing      | No approved remote relay/provider boundary                                                                                                                  | M7            |
| Detachable remote sessions                           | UP-005                 | Supported    | Durable target/session identity and detached/reconnecting reconciliation across restart                                                                     | M7            |
| Remote tmux discovery/attach/create/mirror           | UP-006                 | Supported    | Bounded tmux discovery/create/attach and exact identity across transport loss                                                                               | M7            |
| Resizable right sidebar and dock                     | UP-007, UP-008, UP-011 | Supported    | Durable left/right placement, bounded resizing, and eight fixed productivity surfaces                                                                       | M8            |
| TextBox and local notes                              | UP-008, UP-011         | Supported    | Bounded durable TextBox documents behind typed service/main/preload operations                                                                              | M8            |
| Vault local transcript index/search                  | UP-012                 | Supported    | Local consented encrypted index with retention, exclusion, forget, rebuild, and source-scoped export                                                        | M8            |
| Task Manager with authoritative destructive controls | UP-011                 | Supported    | Authoritative agent and remote tasks only, with native confirmation for destructive actions                                                                 | M8            |
| File explorer/preview, Markdown, and diff viewers    | UP-008, UP-011         | Supported    | Opaque path-authorized content identities, bounded reads, safe Markdown AST, and diff contracts                                                             | M8            |
| Global search                                        | UP-007, UP-011         | Supported    | Bounded, local, consented and source-scoped search protocol and surface                                                                                     | M8            |

## Optional and explicitly out-of-scope capabilities

| Capability                                                 | Upstream evidence | Local status | Reason                                                                        |
| ---------------------------------------------------------- | ----------------- | ------------ | ----------------------------------------------------------------------------- |
| Native Swift/AppKit/Ghostty implementation                 | UP-001            | Out of scope | Electron/Rust/xterm.js replacement is not required for Linux behavior parity. |
| Browser profile import from third-party browsers           | UP-001            | Out of scope | Not a Tier A requirement in the approved roadmap.                             |
| iOS companion and cloud coordination                       | UP-001            | Out of scope | Tier C; requires separate identity, sync, privacy, and support decisions.     |
| Upstream product identity, icons, wording, and trade dress | UP-001            | Out of scope | Explicit clean-room non-goal.                                                 |

## Completeness rule

An inventory row moves to Supported only when the current repository contains an authoritative
implementation and tests at the row's trust boundary. Visual similarity, renderer-only state, an
unexecuted workflow, or a roadmap entry is insufficient. Changes to this inventory require a linked
evidence-log update.

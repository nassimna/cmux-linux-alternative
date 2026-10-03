> Historical Rust-era design record. The current Node/TypeScript architecture and release path are documented in [Architecture](ARCHITECTURE.md).

# M0–M8 implementation work breakdown

These local issue handles decompose the parity specification without creating external tracker
state. An item is complete only with implementation, focused tests, review, and the listed retained
evidence. Dependencies are release ordering, not permission to weaken an earlier invariant.

| ID      | Milestone | Work item                                                                        | Dependency                                  | Completion evidence                                         |
| ------- | --------- | -------------------------------------------------------------------------------- | ------------------------------------------- | ----------------------------------------------------------- |
| PAR-000 | M0        | Maintain pinned clean-room evidence and capability inventory                     | None                                        | Evidence log and every inventory row classified             |
| PAR-001 | M0        | Assign contract ownership, trust, compatibility, and tests                       | PAR-000                                     | Contract matrix and accepted boundary ADRs                  |
| PAR-002 | M0        | Retain baseline protocol/Rust/desktop regression report                          | PAR-001                                     | Generation, Rust workspace tests, `pnpm validate`           |
| PAR-100 | M1        | Implement authoritative attention taxonomy, rings, navigation/read transitions   | PAR-002                                     | Core/control properties, renderer/a11y/visual tests         |
| PAR-101 | M1        | Expand fixed bounded card-slot contracts and safe providers                      | PAR-100                                     | ADR, Rust/Zod parity, invalidation/storm tests              |
| PAR-102 | M1        | Implement dense/normal/expanded card anatomy and stable actions                  | PAR-101                                     | Interaction, accessible-name, visual matrix                 |
| PAR-103 | M1        | Qualify card performance, forced colors, zoom, reduced motion                    | PAR-102                                     | A11y/visual/performance comparison evidence                 |
| PAR-200 | M2        | Add pin/group/selection invariants and migrations                                | PAR-103                                     | Core properties, migration/recovery tests                   |
| PAR-201 | M2        | Add batch mutations and pointer/keyboard multiselect                             | PAR-200                                     | Protocol/renderer E2E and focus restoration                 |
| PAR-202 | M2        | Add saved layouts with atomic apply/rollback/import/export                       | PAR-201                                     | Runtime rollback and live-session preservation              |
| PAR-300 | M3        | Add advanced duplicate/move/reopen/detach tab contracts                          | PAR-202                                     | Typed command and lifecycle tests                           |
| PAR-301 | M3        | Add service window registry plus private desktop provider registration/leases    | PAR-300                                     | Multi-window crash/rehome/lease/transfer E2E                |
| PAR-400 | M4        | Add action registry, discovery, invocation, CLI JSON                             | PAR-301                                     | Auth/schema/backpressure/CLI tests                          |
| PAR-401 | M4        | Extend the M3 provider with durable public-action reverse execution/start claims | PAR-400                                     | Expiry/arbitration/start/cancel/exactly-once tests          |
| PAR-402 | M4        | Add safe project custom commands and palette/shortcut parity                     | PAR-401                                     | Policy, confirmation, escaping, E2E                         |
| PAR-500 | M5        | Add addressable browser automation sessions and primitives                       | PAR-402                                     | Deterministic automation E2E                                |
| PAR-501 | M5        | Enforce hostile-origin, permission, download, cancellation, cleanup policy       | PAR-500                                     | Security/race/leak/package evidence                         |
| PAR-600 | M6        | Add resumability levels, agent adapters, and session catalog                     | PAR-202, PAR-402                            | Adapter/restart/privacy matrix                              |
| PAR-601 | M6        | Add fork provenance, teams/subagent splits, exact attention routing              | PAR-600                                     | Graph/routing/restart E2E                                   |
| PAR-602 | M6        | Add safe hibernation and degraded restore UX                                     | PAR-601                                     | Confirmation and uncheckpointed-work tests                  |
| PAR-700 | M7        | Add remote target/session/credential/host-key model                              | PAR-402, PAR-600                            | Security, migration, hermetic SSH tests                     |
| PAR-701 | M7        | Add reconnect/detach and remote tmux lifecycle                                   | PAR-700                                     | Hermetic disconnect/tmux identity E2E                       |
| PAR-800 | M8        | Add sidebar/dock registry and safe restoration                                   | PAR-301, PAR-402, PAR-501, PAR-602, PAR-701 | Resize/focus/a11y/restore tests                             |
| PAR-801 | M8        | Add TextBox, task manager, recently closed, files/Markdown/diffs                 | PAR-800, PAR-501, PAR-602, PAR-701          | Path/HTML/process security and E2E                          |
| PAR-802 | M8        | Add local Vault/global search indexing with exclusions/retention                 | PAR-801, PAR-602, PAR-701                   | Index/privacy/deletion/migration tests                      |
| PAR-900 | Global    | Qualify exact final candidate                                                    | PAR-103 through PAR-802                     | All global commands, soak, package, security, human reviews |

## Review policy

Every item that changes protocol, persistence, process ownership, authentication, authorization, or
trust boundaries requires its accepted ADR/RFC before code. Each milestone ends with an independent
review against its acceptance criteria; later progress does not waive an unresolved earlier finding.

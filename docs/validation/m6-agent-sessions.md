# M6 agent-session validation

Status: M6-AC-01 through M6-AC-04 are implemented and independently reviewed clean. This record is
focused milestone evidence, not exact-candidate qualification.

## Implemented boundary

- `crates/protocol/src/agent_sessions.rs` defines the bounded `agent-sessions-v1` DTOs and explicit
  restore levels/outcomes.
- `crates/agent-session-runtime/src/lib.rs` owns adapter capability evaluation, restore/fork plans,
  verified checkpoint evidence, and hibernation disposition without claiming process-memory
  cloning.
- `crates/storage/src/agent_sessions.rs` persists the durable session catalog, fresh fork identity
  and immutable provenance, team/member topology, exact workspace/pane/tab/session attention, and
  revision-fenced confirmation state.
- `crates/control-server/src/agent_sessions.rs` owns authenticated operations, restart
  reconciliation, exact attention routing, stale-evidence rejection, and destructive-action
  confirmation checks.
- `apps/desktop/src/main/desktop-ipc.ts`, `apps/desktop/src/preload/index.ts`, and the workspace
  renderer expose only typed agent operations; native confirmation remains main-owned.

## Acceptance review

| Criterion                                     | Result | Focused evidence                                                                                                                |
| --------------------------------------------- | ------ | ------------------------------------------------------------------------------------------------------------------------------- |
| M6-AC-01 restore classification               | Pass   | Live reattach, tool-supported resume, layout-only restart, and unavailable are distinct and evidence-fenced.                    |
| M6-AC-02 independent fork identity/provenance | Pass   | Fork creation requires a fresh durable UUID and retains immutable source/artifact provenance.                                   |
| M6-AC-03 durable exact team/subagent routing  | Pass   | Team/member and attention records bind the exact workspace, pane, tab, and agent session and survive catalog reload.            |
| M6-AC-04 safe hibernation                     | Pass   | Uncheckpointed work is not silently treated as resumable; destructive disposition requires an explicit main-owned confirmation. |

The independent review found no acceptance-blocking issue. Focused storage, agent runtime, control
server, protocol/bindings, and desktop tests provide the implementation evidence for this result.

## Qualification boundary

This record does not claim that final `pnpm validate`, global Rust/Electron, packaged E2E, visual,
accessibility, performance, package, human assistive-technology, native-platform, signing, hosted
release, or publication gates passed for an exact candidate.

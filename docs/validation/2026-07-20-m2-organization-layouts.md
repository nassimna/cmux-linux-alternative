# M2 organization and saved-layout validation — 2026-07-20

## Decision

M2 passes. Workspace selection, pins, ordered/collapsible groups, batch close, legacy-limit
reduction, and portable saved layouts are authoritative, durable, capability-gated, and exposed in
the desktop and CLI. Layout application uses preflight plus one lifecycle transaction.

## Candidate identity

The workspace has no Git `HEAD`; the exact tested source candidate is therefore identified by:

```text
algorithm=sha256 fileCount=514 digest=078c90e81c50dea8af54fa07038afbecf823799d119f36a86aaa3963d2212e0e
```

Final release qualification still requires a committed candidate under PAR-QUAL-007.

## Acceptance evidence

- **M2-AC-01:** Pointer and keyboard flows share the authoritative selection commands. Packaged
  Electron tests cover selection, focus, pin/group/collapse/reorder, batch close, and replacement.
- **M2-AC-02:** Schema-v4 migrations cover legacy snapshots and over-limit reduction. Restart tests
  cover groups, assignments, collapse, pins, selection, close cleanup, and layouts. A packaged
  migration test loads 129 browser workspaces, reduces to 128, and proves the marker clears and
  persists.
- **M2-AC-03:** Layout import/export is strict, bounded, path-authorized, runtime-secret-free, and
  owner-only on disk. Invalid preflight/save/create cases are atomic; valid apply preserves eligible
  terminal and canonical browser sessions while revoking removed sessions.

## Lifecycle and security regressions

- Explicit terminal close immediately removes the authoritative attachable session.
- Batch close and layout replacement prune both ephemeral card-slot generations.
- Deterministic interleavings prove close cannot race a v2 slot replacement into stale state and a
  concurrently created workspace cannot be deleted by stale-slot cleanup.
- Export uses strict camelCase pane-tree fields while accepting the documented legacy aliases.
- Import remaps browser runtime identities and resets profile isolation; local apply may preserve an
  eligible live browser session without persisting its private URL state.

## Gates

| Gate                                                                                         | Result |
| -------------------------------------------------------------------------------------------- | ------ |
| Core, storage, workspace-runtime, terminal-runtime, protocol, control-server, and CLI suites | PASS   |
| Control-server strict Clippy and 64-test suite                                               | PASS   |
| Desktop type checks and 569-test Vitest/package/helper suite                                 | PASS   |
| Packaged workspace, legacy migration, accessibility, and deterministic visual E2E            | PASS   |
| Production service/CLI/desktop builds                                                        | PASS   |
| Repository `pnpm validate` on the exact fingerprint                                          | PASS   |
| Independent integrated review, including concurrency remediation                             | PASS   |

No gate failure was suppressed. Existing `ts-rs` attribute-interpretation warnings are covered by
the paired strict deserializer and Zod tests.

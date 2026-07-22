# M3 advanced tabs and multi-window validation — 2026-07-20

## Decision

M3 passes. Window registration, renderer ownership, live terminal/browser transfer, deterministic
window-loss recovery, advanced tab actions, and keyboard access are implemented through the typed
service contract and the packaged desktop.

## Acceptance evidence

- **M3-AC-01:** Cross-window terminal and browser moves use one authoritative owner, fenced source
  and target generations, and explicit provider transfer. The packaged multi-window suite covers
  successful moves, stale requests, target loss, source cleanup, and duplicate-runtime prevention.
- **M3-AC-02:** Close/crash reconciliation is deterministic. Window-registry tests cover rehome,
  restore, and terminal/browser cleanup without orphaned renderer ownership or attachable duplicate
  views.
- **M3-AC-03:** Advanced tab actions are represented by typed commands and exposed through the
  command palette, application menu, shortcuts, and keyboard-operable tab UI. Packaged accessibility
  tests cover focus order and operation without a pointer.

## Gates

| Gate                                                                                  | Result |
| ------------------------------------------------------------------------------------- | ------ |
| Packaged desktop E2E (`17 passed`)                                                    | PASS   |
| Deterministic visual regression (`3 passed`)                                          | PASS   |
| Packaged accessibility (`3 passed`)                                                   | PASS   |
| Window-registry regression (`1 passed`)                                               | PASS   |
| Representative packaged performance (`1 passed`, no required failures or regressions) | PASS   |
| Repository validation on the M3 candidate                                             | PASS   |

The retained qualification logs are `/tmp/m3-desktop-e2e-qualified.log`,
`/tmp/m3-desktop-visual-qualified.log`, `/tmp/m3-desktop-a11y-qualified.log`,
`/tmp/workspace-ui-m3-window-registry-fixed.log`, and
`/tmp/m3-desktop-performance-qualified-rerun-2.log`. Global release qualification will rerun the
applicable gates against the final M0–M8 candidate.

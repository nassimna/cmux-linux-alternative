# M4 public actions validation — 2026-07-20

## Decision

M4 packaged qualification passes. The exact production service, CLI, desktop main/preload, and
renderer bundles were rebuilt before the qualifying run. A copied packaged Electron distribution
then exercised the real service supervisor, owner-only session discovery, fresh authenticated CLI
sockets, reverse desktop provider, and native main-process project confirmation dialog.

## Acceptance evidence

- **M4-AC-01:** The packaged `actions-v1` registry exposed the fixed Tier A service and desktop
  actions plus the trusted project actions. An unavailable approved executable was neither listed
  nor invocable.
- **M4-AC-02:** Pin, group rename, group collapse, desktop focus, cancellation, timeout, caller
  loss, explicit unregister, terminal replay, duplicate acknowledgement, and no-provider outcomes
  were stable and fail-closed.
- **M4-AC-03:** A contained native project executable received shell-looking text as one literal
  argv element. Denial had no preapproval side effect. Missing executables, executable symlinks,
  and lexical path escape failed closed; bounded results exposed only byte counts, truncation, exit
  class, duration, and redaction counts.
- **M4-AC-04:** Desktop focus selected the exact target provider. A deliberately delayed terminal
  acknowledgement raced explicit unregister and converged to one durable interrupted result;
  replay remained stable, the late acknowledgement could not replace it, and a later explicit
  target failed `provider_ineligible`.

## Packaged qualification matrix

| Flow                                                            | Result                       |
| --------------------------------------------------------------- | ---------------------------- |
| Fresh-socket identify, action list, service pin/rename/collapse | PASS                         |
| Desktop focus, idempotent replay, duplicate acknowledgement     | PASS                         |
| Literal argv, native approve/deny, no preapproval side effect   | PASS                         |
| Output bounds/content-free result, timeout, cancel, caller loss | PASS                         |
| Forged/stale/replayed confirmation responses                    | PASS                         |
| Missing executable, executable symlink, lexical path escape     | PASS                         |
| Delayed acknowledgement + unregister + interrupted replay       | PASS                         |
| Post-unregister explicit target selection                       | PASS (`provider_ineligible`) |

## Content-free evidence

The qualifying evidence is:

```text
/tmp/agent-workspace-m4-validation/e5ddbf8407cc9fbf4013-816cf15685ac2b808710/m4-actions.json
/tmp/agent-workspace-m4-validation/e5ddbf8407cc9fbf4013-816cf15685ac2b808710/native-confirmations.jsonl
```

The JSON evidence contains only acceptance labels, pass/fail check names, dialog decisions, and an
action count. The dialog trace contains only the trusted title, decision index, and number of
content-free detail lines. Neither artifact contains provider/control authority, argv, paths,
stdout/stderr, environment values, or the private output marker.

## Gates

| Gate                                                 | Result              |
| ---------------------------------------------------- | ------------------- |
| Exact service and CLI debug build                    | PASS                |
| Exact production desktop main/preload/renderer build | PASS                |
| Targeted Prettier and ESLint                         | PASS                |
| Packaged M4 Playwright suite, one worker             | PASS (32.4 seconds) |

Final command:

```sh
pnpm exec playwright test e2e/actions-m4.spec.mjs --workers=1 --timeout=180000
```

The recurring `ts-rs` serde-attribute interpretation warnings are pre-existing generator warnings;
the paired Rust deserializers, generated Zod schemas, and packaged protocol flows remained green.

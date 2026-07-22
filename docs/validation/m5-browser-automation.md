# M5 browser automation validation — 2026-07-20

## Decision

M5 packaged qualification passes. The exact production service, CLI, desktop main/preload, and
renderer bundles were rebuilt before three packaged Electron flows exercised trusted attach
confirmation, isolated ephemeral automation, and deterministic provider/window races through fresh
authenticated CLI sockets. All four acceptance criteria pass.

## Acceptance evidence

- **M5-AC-01 — PASS:** A hostile local page observed no Node global, Electron API, desktop preload
  bridge, control token, persistent partition, or data from a second automation profile. Each
  ephemeral session used an isolated non-persistent Electron session.
- **M5-AC-02 — PASS:** Canceling and destroying sessions settled pending waits, closed the hidden
  automation window, cleared session state, and returned the live `WebContents` and remote-page
  counts to their recorded baseline without duplicate navigation or console errors.
- **M5-AC-03 — PASS:** The packaged flow exercised navigation, query, type, click, screenshot,
  screenshot release/expiry, popup denial, download denial, geolocation denial, and external-URL
  denial. The screenshot was reassembled from bounded chunks, verified by SHA-256, and had the
  requested 320 x 240 dimensions before its retained bytes were released and zeroized.
- **M5-AC-04 — PASS:** Two real claimed windows received sessions fenced to distinct window IDs and
  positive generations. Pending operations were then subjected to an exact provider transport
  disconnect, a real 15-second lease expiry produced by dropping heartbeats without unregistering,
  and destruction of the exact owning native window. Each operation reached one stable terminal
  result, replay returned the same result, and the provider delivered each operation exactly once.
  Recovery never retargeted the other session. After native rehome, one renderer was removed, the
  two legitimate browser pages belonged to the surviving window, and no hidden automation window
  remained.

## Qualification matrix

| Flow                                                                     | Result |
| ------------------------------------------------------------------------ | ------ |
| Trusted attach denial, exact-target approval, stale-target rejection     | PASS   |
| Fresh-socket create, navigate, wait, query, type, and click              | PASS   |
| Hostile-page Node/bridge/token/profile-isolation probes                  | PASS   |
| Popup, download, permission, and external-URL policy probes              | PASS   |
| Screenshot chunks, dimensions, digest, release, expiry, and zeroization  | PASS   |
| Cancellation, destroy-with-pending-work, and lifecycle cleanup           | PASS   |
| Console errors, duplicate navigation, and `WebContents` leak checks      | PASS   |
| Two claimed windows and exact session ID/generation routing              | PASS   |
| Exact provider transport disconnect, recovery, replay, and no redispatch | PASS   |
| Heartbeats dropped through the real 15-second lease interval             | PASS   |
| Exact native owner destruction, stable replay, rehome, and leak check    | PASS   |

## Content-free evidence

The qualifying evidence is:

```text
/tmp/agent-workspace-m5-final-20260720-1912/031ba4e46b292a155137-5ab2be557fe745c414d2/m5-browser-automation.json
/tmp/agent-workspace-m5-final-20260720-1912/031ba4e46b292a155137-3489b2fd12c01965a92e/m5-provider-window-races.json
/tmp/agent-workspace-m5-final-20260720-1912/031ba4e46b292a155137-31449afffcdc2b276ec2/attach-confirmation.jsonl
```

The compact JSON files contain acceptance labels, baseline/final counts, operation states,
structural network counts, screenshot size/chunk/digest metadata, terminal classes, delivery
counts, and boolean target-fence checks. They exclude screenshot bytes, page text, typed text,
selectors, storage values, tokens, and persistent profile data. The attach trace contains native
dialog choices, redacted acknowledgement envelopes, and bounded opaque
operation/session/correlation UUIDs. Those identifiers convey no control authority, profile data,
or page content. The compact race JSON records boolean target-fence checks rather than concrete
target IDs.

## Gates

| Gate                                           | Result                  |
| ---------------------------------------------- | ----------------------- |
| Rust formatting                                | PASS                    |
| `agent-workspace-control-server` compile check | PASS                    |
| Focused desktop manager/provider/view suites   | PASS (47/47)            |
| Exact production desktop build                 | PASS                    |
| Extended focused recovery/routing suites       | PASS (72/72)            |
| Packaged M5 Playwright suite, one worker       | PASS (3/3, 2.7 minutes) |

Final command:

```sh
AGENT_WORKSPACE_EVIDENCE_DIR=/tmp/agent-workspace-m5-final-20260720-1912 \
  pnpm --filter @agent-workspace/desktop test:m5
```

The recurring `ts-rs` serde-attribute interpretation warnings are pre-existing generator warnings;
the Rust compile check, generated-schema consumers, and packaged protocol flows remained green.

# M1 cards and attention validation — 2026-07-20

## Decision

M1 passes. The application now owns a strict, bounded rich-card contract, five-state attention,
progressive card density, stable card action IDs, and exact target navigation. The M2-owned pin,
group, collapse, and multiselect clauses were subsequently qualified by M2.

## Candidate identity

The workspace has no Git `HEAD`; the exact tested source candidate is therefore identified by the
repository fingerprint:

```text
algorithm=sha256 fileCount=514 digest=078c90e81c50dea8af54fa07038afbecf823799d119f36a86aaa3963d2212e0e
```

Final release qualification still requires a committed candidate under PAR-QUAL-007.

## Acceptance evidence

- **M1-AC-01:** Rust and Zod reject malformed, oversized, mismatched, and unsafe payloads for all
  nine slot kinds. Renderer tests cover dense, normal, expanded, primary, overflow, empty, and
  mixed states. Packaged accessibility and deterministic visual suites pass.
- **M1-AC-02:** Per-client invalidations are coalesced and bounded; lag requires cursor resync.
  The 10,000-update storm test proves one bounded state entry, and control-server tests prove ping
  and PTY output are not starved.
- **M1-AC-03:** Attention is service-owned, revisioned, and derived from card and notification
  sources. Exact workspace/pane/tab jumps and read transitions are covered across Rust, renderer,
  and packaged Electron tests.

## Gates

| Gate                                                                       | Result |
| -------------------------------------------------------------------------- | ------ |
| Protocol Rust/TypeScript generation and strict fixtures                    | PASS   |
| Core, protocol, runtime, control-server, and renderer unit/property suites | PASS   |
| Packaged accessibility and deterministic visual suites                     | PASS   |
| Repository `pnpm validate` on the exact fingerprint                        | PASS   |
| Independent phase review after remediation                                 | PASS   |

The existing `ts-rs` attribute-interpretation warnings remain informational; canonical Serde and
Zod boundary tests enforce the constraints.

# 0004: Capability naming and contract versioning

**Status:** Accepted

## Context

M0–M8 add optional command families across independently updated Rust services, desktop clients,
preloads, CLI clients, stored data, and privileged Electron providers. Protocol version alone cannot
truthfully communicate partial feature availability, and accepting arbitrary capability strings
would make authorization and compatibility ambiguous.

## Decision

Optional protocol families use lowercase kebab-case capability names ending in `-vN`, where `N` is
the semantic generation of that complete family. Initial planned names are `workspace-groups-v1`,
`card-slots-v1`, `saved-layouts-v1`, `multi-window-v1`, `actions-v1`,
`attention-v1`, `browser-automation-v1`, `agent-sessions-v1`, `remote-sessions-v1`, and
`sidebar-surfaces-v1`. Appearance density expansion uses `configuration-v2`: configuration schema
v2 adds `expanded`, while new readers migrate schema-v1 `compact` and `comfortable` values. A
schema-v1 payload labeled `expanded` is rejected. Services advertise `configuration-v2` only when
the v2 store and wire contract are active; new clients gate expanded UI on it, and old strict
schema-v1 readers reject schema-v2 snapshots instead of silently interpreting the new enum.

The service advertises a capability only when every command, result, event, error, authorization,
bound, cancellation rule, and recovery behavior required by that generation is active. Clients gate
optional UI and calls on the identify response and fail closed when a family is absent. A capability
does not grant authorization by itself; authenticated callers and leased desktop providers still
receive explicit operation scopes.

Additive optional fields may remain within a generation only when older strict validators can
safely ignore or default them according to an explicit compatibility test. A breaking wire or
semantic change creates `-v2` and an explicit rejection path; protocol framing/version changes also
increment the top-level protocol version. Rust types are canonical, generated TypeScript is checked
in, and strict Zod validates untrusted input. CLI machine JSON contains its own schema version.

Capabilities and stable action IDs use separate namespaces. Action IDs are lowercase dotted names
owned by the action registry; they are discoverable records, not executable strings. Electron-owned
capabilities are advertised through expiring provider leases and cannot be inferred from preload
method presence.

## Consequences

- Mixed-version clients can hide unsupported surfaces without probing privileged commands.
- Partial implementations cannot truthfully advertise a complete family.
- Compatibility fixtures must cover identify, absent-family rejection, old-reader behavior, and
  every version transition.
- Capability removal or semantic replacement requires a deprecation window or an accepted breaking
  change decision.

## Alternatives considered

- One monotonically increasing application version was rejected because it cannot express optional
  provider or platform capabilities.
- Per-command feature probing was rejected because it is race-prone and complicates authorization.
- Unversioned capability names were rejected because semantic changes would become silent breaks.

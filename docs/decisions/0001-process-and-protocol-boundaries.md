# 0001: Process and protocol boundaries

**Status:** Accepted

## Context

The application needs native desktop integration, a web-based component ecosystem, durable
long-lived processes, and a CLI that can perform the same domain actions as the UI. Renderer reloads
must not terminate owned processes, and a compromised renderer must not gain unrestricted local
machine access.

## Decision

Electron owns windows, application lifecycle, and the narrow preload bridge. The React renderer is
sandboxed and has neither Node.js access nor a generic IPC command API. A supervised Rust service
owns authoritative domain state and long-lived processes.

Desktop and future CLI clients communicate with the service using authenticated UTF-8 NDJSON over
`interprocess` local sockets on Unix and named pipes on Windows. Rust wire types generate TypeScript
DTOs, while Zod schemas validate untrusted responses at runtime. The first command is the versioned
`system.identify` handshake.

For Milestone 1, the implemented command set is intentionally limited to identity, ping, and
terminal lifecycle operations. Clients attach to individual terminals to receive bounded event
streams. Slow clients receive a resynchronization event and reconstruct from the latest serialized
xterm.js checkpoint plus its ordered output journal.

The desktop creates a 256-bit token, encrypts it with Electron `safeStorage`, and persists only the
ciphertext with owner-only permissions. The token reaches the child service through stdin and never
through arguments, environment variables, URLs, or logs. If a secure credential backend is not
available, the desktop generates a session-only token and persists nothing.

## Consequences

- Renderer reload and renderer failure are independent from service and process lifetime.
- Every renderer capability must be deliberately added to the typed preload bridge.
- Protocol evolution requires regenerated DTOs and compatibility tests.
- Control frames, output chunks, checkpoint payloads, clients, queues, and journals require explicit
  bounds; exceeding an event queue triggers resynchronization rather than unbounded buffering.
- Persistent local authentication depends on an operating-system credential backend; systems without
  one use session-only authentication.
- Packaged builds must place the architecture-specific sidecar at a verified resource path.

## Alternatives considered

- Running PTYs and state in Electron main was rejected because renderer and desktop lifecycle would
  be too closely coupled to durable process ownership.
- Exposing a generic IPC request method was rejected because it would turn the preload bridge into a
  privilege-escalation surface.
- HTTP on localhost was rejected because local sockets provide a narrower, per-user transport without
  browser-origin concerns or a TCP port.

The current implementation details and limits are documented in the
[architecture overview](../ARCHITECTURE.md), [protocol reference](../PROTOCOL.md), and
[security model](../SECURITY_MODEL.md).

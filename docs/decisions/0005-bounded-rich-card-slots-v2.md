# 0005: Bounded rich card slots version 2

**Status:** Accepted

## Context

ADR 0002 deliberately fixes `card-slots-v1` to one complete agent-status/progress snapshot. M1 also
requires pull-request, custom metadata, Markdown, log-tail, checklist, SSH, and media states. Adding
those fields to the strict v1 response would break old clients, while one shared revision would make
frequent progress or log updates refetch every other slot. A generic string-keyed extension map
would weaken validation, compatibility, security, and accessibility policy.

## Decision

The service adds a separate `card-slots-v2` capability and keeps v1 behavior unchanged. V2 uses the
operation family `workspace.cardSlots.v2.get`, `workspace.cardSlots.v2.replace`, and
`workspace.cardSlots.v2Changed`. A request names one workspace and one closed-enum slot kind. The
response contains that workspace ID, kind, JavaScript-safe slot revision, and exactly one nullable
payload from the matching tagged union. Replace requires the expected revision; identical content is
an event-free no-op. The invalidation event carries only workspace ID, kind, revision, and a closed
reason. Overflow recovers by fetching the named latest slot.

The fixed kinds and bounds are:

| Kind          | Payload                                                                                   | Bounds and policy                                                                                                                                    |
| ------------- | ----------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agentStatus` | Status, optional label                                                                    | Existing five-state enum; label 120 scalars. V1 transition identity remains absent.                                                                  |
| `progress`    | Determinate percentage or labeled indeterminate state                                     | Existing 0–100 integer and 120-scalar label rules.                                                                                                   |
| `pullRequest` | Provider label, positive number, title, lifecycle state, checks state, optional HTTPS URL | Provider 40, title 160, URL 2,048 scalars; lifecycle and checks are closed enums.                                                                    |
| `metadata`    | Ordered key/value rows                                                                    | At most 6 rows; key 40 and value 120 scalars; duplicate normalized keys rejected.                                                                    |
| `markdown`    | Markdown source                                                                           | At most 4,096 scalars; raw HTML is treated as text; no embedded images, data URLs, or executable directives.                                         |
| `logTail`     | Ordered text lines and truncation flag                                                    | At most 20 lines of 240 scalars; ANSI/control sequences rejected, never interpreted.                                                                 |
| `task`        | Title and ordered checklist items                                                         | Title 120; at most 12 items; stable UUID item ID, label 160, closed state enum.                                                                      |
| `ssh`         | Public target label and connection state                                                  | Label 120; state is disconnected, connecting, connected, reconnecting, detached, or failed; no host secret, username credential, path, or raw error. |
| `media`       | Media kind, playback state, and label                                                     | Label 160; kind/state are closed enums; no remote asset URL or embedded bytes.                                                                       |

All text is trimmed, non-empty where required, normalized according to the existing protocol text
policy, and rejects Unicode control characters. A serialized slot response is limited to 16 KiB,
inside the existing 1 MiB frame cap. Per-client event queues remain bounded; a workspace can hold at
most one value for each fixed kind. Entries remain process-local and are discarded on workspace
close or service restart. Persistence, third-party slot registration, and arbitrary slot names remain
forbidden without a later ADR.

The renderer uses a fixed component for each kind. Plain metadata, logs, SSH, task, PR, and media
values render as React text. Markdown supports only paragraphs, headings, lists, emphasis, inline or
fenced code, and HTTP/HTTPS links. Raw HTML is escaped; images are omitted; links use the existing
validated external-opening bridge and never receive opener access. Hidden or absent slots create no
focus stops. Slot order and accessible names are fixed across compact, comfortable, and expanded
card presentations.

## Consequences

- High-frequency progress and log changes invalidate only their own slot and cannot rewrite SQLite,
  the application projection, or unrelated card content.
- V1 clients remain compatible; v2 clients must gate every v2 operation on `card-slots-v2`.
- Producers replace one whole typed slot and handle explicit revision conflicts.
- Markdown and media cannot become generic remote-content or extension channels.
- Rust DTOs, generated TypeScript, strict Zod, renderer components, storm tests, forced-colors/zoom,
  reduced-motion, and hostile-content tests are required before advertising v2.

## Alternatives considered

- Extending the strict v1 snapshot was rejected because old readers would fail and all content would
  share one invalidation revision.
- A generic map of slot names to JSON was rejected because it would permit unbounded, unaudited
  content and unstable accessibility semantics.
- Durable SQLite slots were rejected because advisory high-frequency state has no approved
  retention, privacy, migration, or expiry policy.
- HTML rendering and remote media URLs were rejected because they would expand the renderer and
  browser trust boundaries for a card-summary feature.

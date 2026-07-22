# 0003: Authoritative attention taxonomy and transitions

**Status:** Accepted

## Context

The current notification projection exposes unread severity, while the fixed agent-status slot can
express running, waiting, completed, and failed states. Rendering those inputs independently cannot
produce deterministic rings, accessible summaries, ordering, or exact read transitions. M1 requires
informational, completed, waiting, and urgent attention without making the renderer authoritative.

## Decision

The service exposes a derived per-workspace and per-tab attention projection with five states:
`none`, `informational`, `completed`, `waiting`, and `urgent`. Priority is `urgent > waiting >
completed > informational > none`. The projection contains the target workspace and, when known,
pane/tab IDs, a bounded unread count, a reason code from a closed enum, and a JavaScript-safe
revision. It contains no notification body, terminal output, transcript content, or arbitrary HTML.

Durable notification unread/read state remains owned by `crates/core` and transacted by the
workspace runtime. Ephemeral agent status remains in the card-slot sidecar. The control service is
the only component allowed to fold these sources into the combined attention projection. The
renderer maps the state to rings, badges, text, and sorting but cannot promote, clear, or fabricate
attention locally.

Unread error-level notification or failed agent state maps to `urgent`; explicit waiting maps to
`waiting`; a newly completed agent maps to `completed`; other unread notification or informational
agent state maps to `informational`. A higher-priority state cannot be hidden by a lower-priority
source. Version 1 acknowledgement targets an exact durable notification identity. Selecting a
workspace alone does not clear attention. Read/acknowledge commands complete only after the exact
notification target is focused or the caller explicitly invokes a non-navigation acknowledgement.
The version-1 agent-status slot has no transition identity and is therefore not acknowledgeable;
only its producer may replace or clear it. A later acknowledgeable agent transition requires a new
fixed slot generation and ADR rather than inferring identity from status or label text.

Events are bounded invalidations with target ID and revision, not unbounded content delivery.
Overflow or revision gaps force a latest-state refetch. Accessible summaries use stable localized
phrases and never rely on color alone. Animation is optional presentation and must honor reduced
motion.

## Consequences

- Attention ordering and navigation are deterministic across renderer reloads and multiple clients.
- Notification read state remains durable; ephemeral agent completion/waiting state resets with the
  card-slot service unless a later retention ADR is accepted.
- Ring design can vary by theme/density while semantics and action order stay fixed.
- The protocol requires strict DTOs, reason bounds, revision-conflict behavior for acknowledgements,
  and property tests for priority folding and exact-target transitions.

## Alternatives considered

- Renderer-only folding was rejected because multiple clients could disagree and reloads could lose
  transitions.
- Reusing notification severity as the public taxonomy was rejected because severity does not
  represent completed or waiting agent states.
- Clearing on workspace selection was rejected because selecting the wrong tab would lose the exact
  pending target.

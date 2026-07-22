# 0011: Agent session restore, provenance, teams, and hibernation

**Status:** Accepted

## Context

M6 adds truthful restore levels, agent adapters, durable sessions, fork provenance, teams/subagents,
and hibernation. The current terminal runtime supports bounded live reattach while the service and
PTY survive. Service restart deliberately clears runtime IDs and launches new PTYs from durable
layout metadata. Agent hooks publish sanitized notifications only; card slots are ephemeral and
cannot serve as a durable session catalog.

Resume support varies by external tool. Persisting raw transcripts, PTY content, process IDs,
credentials, or opaque resume secrets in the application snapshot would violate existing privacy and
runtime ownership. Claiming process-memory cloning would be false.

## Decision

### Restore taxonomy and adapter contract

The service advertises optional `agent-sessions-v1`. Every restore assessment uses one closed level:

- `liveReattach`: the exact owned PTY/session is still live and can attach to its bounded runtime
  checkpoint/journal;
- `toolResume`: a registered adapter/version verifies a supported resume artifact and invokes the
  tool's documented resume mechanism;
- `layoutRestart`: the durable layout can launch a new process with fresh runtime identity, without
  claiming conversation/process restoration; or
- `unavailable`: required evidence, adapter, authorization, or artifact is absent/expired/invalid.

The level is evaluated from current runtime and adapter evidence on every request. Stale durable
metadata never fabricates liveness or resume success.

Adapters implement a fixed trusted trait with stable adapter ID/version, platform support, declared
launch/resume/fork/checkpoint/hibernate capabilities, artifact kind and limits, and typed bounded
outcomes. Registration is service configuration, not renderer/plugin code. Operations carry an
idempotency UUID, request hash, session revision, and attempt epoch. Unsupported or mismatched
adapter/version/artifact combinations fail explicitly.

The production registration is the closed Linux Codex adapter for CLI `0.142.4`. Startup resolves
and canonicalizes the executable once, rejects non-regular or group/world-writable targets, and
captures its device/inode/owner/mode identity. Each PTY launch opens and revalidates that exact
object including its size and SHA-256 digest, then launches the version-verified snapshot from a
write/grow/shrink-sealed Linux memfd. The descriptor is retained by the service and addressed via
its parent-process `/proc` descriptor path, so PTY child descriptor cleanup cannot create a pathname
race. Version checks, app-server calls, and resume PTYs all execute the same immutable snapshot.
Identity checks use
bounded JSONL app-server calls:
Agent restore verification sets `thread/read.includeTurns: false`; fork uses `thread/fork` with
`excludeTurns: true`. The separate M8 Vault adapter may set `includeTurns: true` only for one exact,
explicitly consented catalog UUID under ADR 0013's bounded, cancellable, text-only projection.
Only exact UUIDs are accepted. Resume launch data is an ephemeral fixed argv plan (`codex resume
<thread-id> --no-alt-screen`) consumed by workspace runtime and is never serialized.

### Durable catalog, provenance, and privacy

The M6 schema is version 13 (stacked beneath the current version 14) and stores a bounded catalog of
at most 512 agent sessions and 64 teams in the validated aggregate. An `AgentSession` has an opaque
UUID, adapter/version, exact workspace/pane/tab
binding, durable intent, closed lifecycle state, restore assessment, bounded role/title metadata,
last verified observation time, and optional team/member identity. Runtime IDs remain ephemeral.

Fork uses the fresh thread UUID returned by the adapter as the durable agent-session identity, then
starts that exact identity in the destination tab. It records an immutable `forkedFrom`
edge and a cryptographic digest plus kind/version of a sanitized adapter artifact. It never copies or
claims to copy PID, PTY, heap/process memory, credentials, raw prompts/transcripts, command text, or
runtime checkpoint bytes. Provenance remains meaningful if the source session is later deleted.
Immediately after the external fork, exact metadata-only orphan provenance is first fsynced to an
atomic owner-only recovery file independent of the primary SQLite transaction, then inserted into
SQLite before catalog attachment. A successful attach or verified exact archive clears it. Startup
imports any recovery file before retrying exact-UUID archive, so a primary orphan-write failure plus
an archive failure cannot lose the cleanup target.

Teams form a bounded acyclic parent/child graph with at most 64 members, unique member/session
binding, normalized role labels, and one exact current workspace/pane/tab/session target per member.
Moves update that target atomically and emit bounded invalidation. Team/card UI is a projection of
the catalog; ephemeral card slots do not become the authority.

Catalog and team mutations do not borrow session operation epochs. Team creation carries an
idempotency UUID, request hash, and exact expected catalog revision. Team update/delete additionally
carry the expected team revision. Member creation carries expected catalog and team revisions;
member update/move/delete additionally carry the expected member revision. These closed identities
provide compare-and-swap authority at the aggregate actually being changed, without inventing a
session anchor or meaningless attempt epoch. The mutation and its first terminal idempotency result
commit atomically; a stale revision is itself replayable and never applies against later state.

Application SQLite stores metadata only by default. Prompt/transcript/PTY content, raw adapter
payloads, command strings, credentials, private environment, and resume secrets are excluded from
snapshots, logs, audit, diagnostics, and backups. Any adapter secret belongs in an OS credential
facility behind an opaque reference. Artifacts have per-adapter consent, size/age/count limits,
expiry, delete/forget semantics, and redacted recovery behavior. Diagnostics expose counts/status,
not content or artifact digests usable as identifiers outside the profile.

### Session and operation state machines

Session lifecycle is:

`created -> launching -> running -> waiting | checkpointing -> hibernated | completed | failed | unavailable`.

Restore outcomes are recorded separately as `liveReattached`, `resumeAttempting`, `resumed`,
`layoutRestarted`, or `unavailable`. Terminal outcomes do not revert; a new attempt has a new epoch.
Durable operation intent is persisted before side effects. Exact terminal results are persisted with
namespaced idempotency; restart reconciles nonterminal attempts to `interrupted` unless the same
trusted adapter proves the exact operation epoch.

Fork performs preflight, prepares/sanitizes the artifact, commits new identity/provenance, dispatches
launch, then records running or a terminal failure. Compensation removes only resources created by
that request; source work is untouched.

Hibernation performs:

`requested -> preflight -> confirmationRequired | checkpointing -> checkpointVerified -> processDispositionPending -> hibernated | terminatedAfterWarning`.

Only an adapter-verified fresh metadata-only checkpoint plus verified owned-process disposition may yield
`hibernated`. Missing, stale, unknown, or unsupported checkpoints require trusted confirmation that
is bound to session ID/revision, exact proposed destructive choice, provider/window generation, and
short-lived nonce. Only its SHA-256 digest is durable; the raw nonce is retained in bounded process
memory and pending challenges are invalidated on restart. Exact unexpired preflight replay returns
the same challenge in the issuing process. Confirmation consumes it once, and terminal confirmation
replay returns the first exact outcome before consulting live side effects. Leaving the process
running uses the dedicated cancel action; it never enters destructive confirmation. Preflight,
checkpoint, confirmation, provider, or persistence failure never silently terminates live work.
Explicit terminate-after-warning records a distinct non-resumable exact-once disposition and never
claims a checkpoint.

Workspace runtime owns disposition: it commits removal of the exact runtime-only PTY identity,
publishes that state, and only then terminates that exact PTY. A termination failure leaves the
binding detached but records an explicit failed disposition; it never records `hibernated`.

### Attention and compatibility

Agent attention records add exact `agentSessionId` and optional team/member IDs while preserving
workspace/pane/tab targeting. Durable terminal session state outranks stale adapter observations;
the established urgent/waiting/completed/informational fold and exact acknowledgement rules apply.
Restart rehydrates the catalog and routing. Deleted or moved targets return explicit unavailable/
retargeted outcomes and never mark another session read.

Rust DTOs are canonical, generated TypeScript/Zod validates all untrusted data, and CLI/action/UI
paths gate on `agent-sessions-v1`. Older services remain usable with agent orchestration hidden.
Saved-layout application may preserve or layout-restart eligible sessions but does not upgrade its
restore claim.

## Consequences

- The product distinguishes live reattach, tool resume, layout restart, and unavailable honestly.
- Fork identity/provenance is durable without pretending to clone running memory.
- Team/subagent attention routes to one exact durable session across restart.
- Hibernation cannot silently kill uncheckpointed work.
- Adapter contract, migration/recovery/corruption, restart/race/idempotency, fork provenance,
  attention routing, privacy scans, confirmation, renderer/CLI, and PTY reconstruction E2E tests are
  required before M6 qualification.

## Alternatives considered

- Treating every relaunched PTY as “resumed” was rejected because layout reconstruction does not
  restore process or conversation state.
- Persisting terminal runtime checkpoints as agent state was rejected because they are bounded live
  renderer reconstruction data, not durable process checkpoints.
- Using card-slot state as the session catalog was rejected because slots are intentionally
  ephemeral and workspace-scoped.
- Copying adapter payloads/transcripts for fork was rejected for privacy, portability, and truthfulness.
- Killing a process when checkpoint support is uncertain was rejected because destructive ambiguity
  requires explicit confirmation.

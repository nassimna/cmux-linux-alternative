# cmux behavior and design parity implementation specification

<!-- markdownlint-disable MD013 MD060 -->

**Status:** M0–M8 implementation present; exact-candidate qualification pending; no parity or compatibility claim
**Audience:** Maintainers, contributors, reviewers, release engineers, security reviewers, and issue authors
**Audit date:** 2026-07-21
**Document version:** 0.1
**Local target:** Current repository state on the audit date
**Upstream baseline:** `manaflow-ai/cmux` `main` at `6849b9351c4a776680ffef34a0323c15e88ea0e7` (2026-07-18), with official release documentation through `0.64.19` (2026-07-14)

## 1. Purpose and requirement language

This document defines a clean-room, issue-trackable roadmap from the current local application to behavioral and design parity with the audited cmux desktop capabilities. It describes outcomes and independently designed contracts; it does not authorize copying upstream source, assets, names, trade dress, or private implementation details.

- **MUST** means release-blocking within the stated parity tier.
- **SHOULD** means expected unless an accepted RFC or ADR records the reason and replacement behavior.
- **MAY** means optional and cannot block a higher-priority tier.
- **Observed** means evidenced in the pinned upstream baseline or official documentation.
- **Implemented** means present in this repository and covered by repository tests; it is not a release claim.
- **Validated** means exercised on a named target with retained evidence.
- **Qualified** means all applicable release, accessibility, performance, security, migration/recovery, observability, packaging, and publication gates have passed for the exact candidate.

Parity statements MUST identify the baseline, tier, platform, and evidence. “Implemented,” “validated,” and “qualified” MUST NOT be used interchangeably.

## 2. Reproducible baselines

### 2.1 Local evidence

- [Full implementation specification](IMPLEMENTATION_SPEC.md)
- [Architecture](ARCHITECTURE.md)
- [Implementation milestone audit](IMPLEMENTATION_MILESTONE_AUDIT.md)
- [Local control protocol](PROTOCOL.md)
- [Known limitations](KNOWN_LIMITATIONS.md)
- [Repository roadmap](../ROADMAP.md)

### 2.2 Upstream evidence

- [Pinned upstream commit](https://github.com/manaflow-ai/cmux/commit/6849b9351c4a776680ffef34a0323c15e88ea0e7)
- [Upstream repository at the pinned tree](https://github.com/manaflow-ai/cmux/tree/6849b9351c4a776680ffef34a0323c15e88ea0e7)
- [Official cmux documentation](https://cmux.com/docs)
- [Official cmux changelog](https://cmux.com/docs/changelog)

The commit is the source-of-truth code baseline. Release documentation is behavior evidence only where it applies through `0.64.19`. Later upstream behavior MUST enter through a new dated audit and baseline update, not silent scope growth.

## 3. Scope and parity tiers

### 3.1 Tier A — Linux desktop release-blocking

Tier A covers polished workspace cards and attention, pinning/groups/layouts, advanced tab and window actions, public action API, browser automation, restoration and agent orchestration, SSH/remote tmux, and right-sidebar productivity surfaces. Milestones M0 through M8 MUST be complete and qualified on Linux before claiming Linux desktop functional parity with this baseline.

### 3.2 Tier B — advanced desktop

Tier B covers extensibility, custom actions, project layouts, skills, sidebar extensions, and native implementation work that does not change Tier A ownership or security boundaries. Tier B SHOULD preserve protocol-level behavior across desktop targets but is not a Linux Tier A release blocker unless promoted by ADR.

### 3.3 Tier C — optional companion, cloud, and native implementation

Tier C covers an optional iOS companion, cloud coordination, and a native macOS implementation. These capabilities MAY be developed after their security, identity, sync, and support models are approved. They are non-blocking for Linux parity.

### 3.4 Explicit non-goals

- Copying upstream source, assets, identity, icons, wording, or trade dress.
- Replacing Electron, Rust, xterm.js, or the current PTY stack with Swift, AppKit, or Ghostty merely to claim parity.
- Arbitrary process-memory checkpointing or promising byte-perfect restoration of an uncooperative process.
- Claiming mobile, cloud, native macOS, Windows, or remote-host support without target-specific qualification.
- Weakening the service-authoritative model to accelerate renderer-only prototypes.

## 4. Current gap matrix

| Capability                                                     | Current status | Owning boundary                                 | Target           |
| -------------------------------------------------------------- | -------------- | ----------------------------------------------- | ---------------- |
| Workspaces, recursive splits, tabs, PTY/xterm                  | Supported      | `core`, `workspace-runtime`, `terminal-runtime` | M0 regression    |
| Isolated Electron browser views                                | Supported      | Electron main                                   | M0 regression    |
| Workspace CRUD, reorder, duplicate                             | Supported      | Service/domain/renderer projection              | M0 regression    |
| Basic card color/name/path/git/process/ports/attention         | Supported      | Core metadata + renderer                        | M1               |
| Rich card design and attention rings                           | Supported      | Core attention + renderer                       | M1               |
| Advanced tab actions                                           | Supported      | Runtime/protocol/main                           | M3               |
| Agent session resume                                           | Supported      | Runtime/adapter/control/desktop                 | M6               |
| Browser automation                                             | Supported      | Electron main/control server                    | M5               |
| Full action CLI/socket and project customization               | Supported      | Protocol/control server/CLI                     | M4               |
| Public update feeds, signing, and publication qualification    | Partial        | Electron main/release                           | Global gates     |
| Optional native desktop implementation and qualification       | Partial        | Platform applications/release                   | M9, non-blocking |
| Pinning, multiselect, and groups                               | Supported      | Core/runtime/store                              | M2               |
| Rich card metadata/content slots                               | Supported      | Core/protocol/renderer                          | M1               |
| Saved layouts                                                  | Supported      | Runtime/store/renderer                          | M2               |
| Fork conversation                                              | Supported      | Runtime/store/agent adapter                     | M6               |
| Multi-window and cross-window movement                         | Supported      | Electron main/service                           | M3               |
| TextBox and Vault                                              | Supported      | Core/store/content index/renderer               | M8               |
| Task Manager, Dock, right sidebar                              | Supported      | Service/main/renderer                           | M8               |
| File, Markdown, diff, global search, recently closed           | Supported      | Service/content index/main/renderer             | M3/M8            |
| SSH, detachable remote sessions, remote tmux                   | Supported      | Terminal/runtime/security                       | M7               |
| Remote browser routing and local notification relay            | Missing        | No approved remote relay/provider boundary      | Unscheduled      |
| Agent teams, native subagent splits, hibernation, broad resume | Supported      | Runtime/agent adapters/store                    | M6               |
| Project layouts, skills, and sidebar extensions                | Missing        | Config/action API/renderer                      | M9               |
| iOS companion                                                  | Missing        | Optional companion architecture                 | M9, non-blocking |

## 5. Workspace card target

### 5.1 Anatomy

- **PAR-CARD-001:** A card MUST expose selection, pin state, group membership, color, editable name, repository/path context, git branch/status, foreground process, listening ports, and attention state.
- **PAR-CARD-002:** A card MUST provide stable slots for PR status, custom metadata, Markdown, bounded log tail, progress, task/checklist, SSH state, media activity, and agent status; absent slots MUST consume no interaction space.
- **PAR-CARD-003:** Primary, secondary, and overflow actions MUST remain keyboard reachable and MUST map to stable action IDs.
- **PAR-CARD-004:** Attention MUST distinguish informational, completed, waiting, and urgent states without relying on color alone; rings and badges MUST derive from authoritative state.
- **PAR-CARD-005:** Dense, normal, and expanded presentations SHOULD share content semantics and action order.
- **PAR-CARD-006:** Card slot payloads MUST be bounded, sanitized, and independently invalidatable so high-frequency logs or progress do not rewrite unrelated workspace state.

### 5.2 Visual and accessibility requirements

- **PAR-A11Y-001:** Cards MUST preserve visible focus, selected, attention, hover, and disabled states in dark, light, forced-colors, and high-zoom modes.
- **PAR-A11Y-002:** The accessible name MUST include workspace name and attention summary; metadata changes SHOULD use restrained live-region announcements.
- **PAR-A11Y-003:** Multiselect, drag, pin, group collapse, and context actions MUST have keyboard equivalents and deterministic focus restoration.
- **PAR-A11Y-004:** Ring thickness, contrast, truncation, wrapping, and hit targets MUST be verified against existing repository accessibility and visual baselines.
- **PAR-A11Y-005:** Motion MUST honor reduced-motion preferences; animated progress MUST have a nonanimated textual equivalent.
- **PAR-A11Y-006:** Media and Markdown slots MUST not introduce remote execution, unsafe HTML, focus traps, or unlabeled controls.

## 6. Architecture ownership constraints

- **PAR-CORE-001:** `crates/core` `ApplicationState` MUST own checked domain invariants and authoritative projections.
- **PAR-CORE-002:** `crates/workspace-runtime` `WorkspaceRuntime` MUST transact domain mutation, persistence ordering, and runtime side effects; partial success MUST be recoverable or rejected.
- **PAR-CORE-003:** `crates/storage` `SqliteStateStore` MUST own versioned migrations, backups, integrity checks, and durable restoration.
- **PAR-PROTO-001:** Rust protocol types MUST remain canonical and generated TypeScript bindings MUST validate all untrusted wire data.
- **PAR-SEC-001:** `crates/control-server` MUST authenticate local clients, authorize actions by capability, bound messages, and preserve replay/backpressure rules.
- **PAR-TERM-001:** `TerminalManager` in the terminal runtime MUST own PTY processes, attachment, resize, ordered output, exit, and supported checkpoint metadata.
- **PAR-BROWSER-001:** Electron main MUST own remote `WebContentsView` creation, isolation, navigation, permissions, downloads, automation, and destruction.
- **PAR-PRELOAD-001:** Preload MUST remain a fixed, frozen, operation-specific bridge; no generic IPC, Node, or Electron primitive may reach renderers.
- **PAR-UI-001:** The renderer MUST remain a non-authoritative projection plus ephemeral interaction state; it MUST NOT invent durable domain success.
- **PAR-DESKTOP-001:** Service-requested actions that require Electron-owned capabilities MUST use an authenticated, capability-scoped desktop provider contract with explicit registration, lease expiry, target-window arbitration, acknowledgements, cancellation, and disconnect behavior; the service and renderer MUST NOT impersonate Electron-owned execution.
- **PAR-ARCH-001:** Process, protocol, persistence, authentication, authorization, or trust-boundary changes require an accepted RFC or ADR before implementation.

## 7. Proposed domain and public contracts

All names in this section are **proposed pending ADR**. They are planning handles, not current API promises.

### 7.1 Proposed domain concepts

- `WorkspaceGroup`, `WorkspaceSelection`, `WorkspacePin`, `CardSlot`, `SavedLayout`, `WindowPlacement`, `ClosedItemRecord`, `ActionDefinition`, `ActionInvocation`, `DesktopCapabilityLease`, `DesktopExecutionRequest`, `AutomationSession`, `AgentSession`, `AgentTeam`, `RemoteTarget`, `RemoteSession`, `SidebarSurface`, `TextBoxDocument`, `TranscriptIndexEntry`, and `TaskRecord`.
- Stable IDs MUST be opaque, globally unique within the local profile, and never derived from display names or mutable paths.
- Domain records MUST separate durable user intent from ephemeral process, browser, connection, and UI state.

### 7.2 Proposed protocol and CLI names

- Protocol capabilities: `workspace-groups-v1`, `card-slots-v1`, `saved-layouts-v1`, `multi-window-v1`, `actions-v1`, `browser-automation-v1`, `agent-sessions-v1`, `remote-sessions-v1`, and `sidebar-surfaces-v1`.
- Commands: `workspace.pin`, `workspace.selectMany`, `group.create`, `group.assign`, `layout.save`, `layout.apply`, `window.create`, `tab.move`, `action.list`, `action.invoke`, `browser.automation.*`, `agent.resume`, `agent.fork`, `remote.connect`, `remote.detach`, `search.global`, and `closed.reopen`.
- CLI surfaces: `workspace pin`, `workspace select`, `group`, `layout`, `window`, `action`, `browser`, `agent`, `remote`, `search`, and `reopen`.
- Configuration sections: `cards`, `groups`, `layouts`, `actions`, `automation`, `agents`, `remotes`, `sidebar`, `vault`, and `extensions`.
- Every accepted ADR MUST define request/result/event DTOs, error codes, authorization, bounded inputs, idempotency, cancellation, and audit behavior.

### 7.3 Compatibility rules

- **PAR-COMPAT-001:** Protocol version changes MUST follow the existing identify/capability handshake; clients MUST gate optional behavior on advertised capabilities.
- **PAR-COMPAT-002:** Additive optional fields MAY remain within a version only when old readers safely ignore them and generated validators remain compatible.
- **PAR-COMPAT-003:** Breaking command, event, or semantic changes MUST increment the protocol version and include an explicit rejection path.
- **PAR-COMPAT-004:** SQLite migrations MUST be ordered, transactional, backed up, tested from every supported source schema, and irreversible only by accepted ADR.
- **PAR-COMPAT-005:** Configuration migrations MUST preserve unknown safe fields where policy allows, reject unsafe ambiguity, and support atomic rollback.
- **PAR-COMPAT-006:** CLI machine-readable output MUST be versioned; human output MAY evolve without breaking documented exit codes.

## 8. Milestone plan

### M0 — baseline and contracts

**Dependency:** Current repository validation baseline.
**Deliverables:** Pinned behavior inventory, clean-room evidence log, capability taxonomy, accepted ownership ADRs, proposed-contract decisions, and issue decomposition.
**Key owner paths:** `docs/`, `crates/core`, `crates/protocol`, `packages/protocol-client`, `apps/desktop`.
**Acceptance:**

- [x] **M0-AC-01:** Every observed capability maps to Supported, Partial, Missing, or out-of-scope evidence. See [`CMUX_CAPABILITY_INVENTORY.md`](CMUX_CAPABILITY_INVENTORY.md).
- [x] **M0-AC-02:** Each proposed contract has an owner, trust boundary, compatibility rule, and test strategy. See [`PARITY_CONTRACT_MATRIX.md`](PARITY_CONTRACT_MATRIX.md) and ADRs 0001–0004.
- [x] **M0-AC-03:** Existing workspace, terminal, browser, persistence, and notification behavior has no regression. See [`validation/2026-07-20-m0-baseline.md`](validation/2026-07-20-m0-baseline.md).

**Validation:** Run protocol generation, Rust tests, `pnpm validate`, and retain the baseline report and diff-reviewed ADRs.

### M1 — cards and attention

**Dependency:** M0.
**Deliverables:** Target card anatomy, bounded slot DTOs, attention taxonomy/rings, progressive density, metadata invalidation, visual and accessibility coverage.
**Key owner paths:** `crates/core`, `crates/workspace-runtime`, `crates/protocol`, `apps/desktop/src/renderer`.

M1 qualifies the card/attention clauses implementable without durable organization state. The pin
and group-membership portion of PAR-CARD-001 and the multiselect/pin/group-collapse portion of
PAR-A11Y-003 are owned and qualified by M2; they remain open global requirements and do not block
starting M2 after the rest of M1 passes.

**Acceptance:**

- [x] **M1-AC-01:** All M1-owned PAR-CARD and PAR-A11Y requirements pass representative states; the
      explicitly M2-owned clauses remain tracked for M2 qualification.
- [x] **M1-AC-02:** Slot storms remain bounded and cannot starve PTY rendering or control traffic.
- [x] **M1-AC-03:** Exact workspace/tab attention navigation and read transitions remain authoritative.

Qualification evidence: [`validation/2026-07-20-m1-cards-attention.md`](validation/2026-07-20-m1-cards-attention.md).

**Validation:** Unit/property tests, renderer interaction tests, a11y suite, deterministic visual suite, and performance comparison with the existing baseline.

### M2 — groups, pinning, multiselect, and saved layouts

**Dependency:** M1.
**Deliverables:** Checked group/pin/selection invariants, batch actions, persisted group order/collapse, saved layouts, atomic apply/rollback, import/export policy.
**Key owner paths:** `crates/core`, `crates/storage`, `crates/workspace-runtime`, `crates/control-server`, renderer sidebar.
**Acceptance:**

- [x] **M2-AC-01:** Pointer and keyboard multiselect produce identical authoritative selections and focus outcomes.
- [x] **M2-AC-02:** Group, pin, reorder, delete, and batch mutations survive restart and migration.
- [x] **M2-AC-03:** Invalid saved layouts leave state and running PTYs unchanged; valid layouts preserve eligible sessions.

Qualification evidence: [`validation/2026-07-20-m2-organization-layouts.md`](validation/2026-07-20-m2-organization-layouts.md).

**Validation:** Property tests for ordering/tree invariants, migration/recovery tests, E2E keyboard/pointer flows, a11y, and visual regression.

### M3 — advanced tabs and multi-window

**Dependency:** M2.
**Deliverables:** Duplicate/move/reopen/detach tab actions, window registry, cross-window movement, recently closed foundation, bounds restoration, crash-safe ownership transfer.
**Key owner paths:** `crates/core`, `crates/workspace-runtime`, Electron main, preload, renderer.
**Acceptance:**

- [x] **M3-AC-01:** Moving a live terminal or browser across windows preserves one authoritative owner and no duplicate runtime.
- [x] **M3-AC-02:** Window close/crash has deterministic rehome, close, or restore behavior with no orphaned views.
- [x] **M3-AC-03:** All advanced tab actions are keyboard complete and available through typed commands.

**Validation:** Multi-window Electron E2E, lifecycle/leak checks, renderer recovery, browser privilege checks, bounds migration, and packaged smoke.

### M4 — public action API and custom commands

**Dependency:** M3 plus accepted action/security and service-to-desktop execution ADRs.  
**Deliverables:** Action registry, discovery/invocation protocol, authenticated CLI/socket coverage, desktop capability-provider registration and leases, reverse execution routing, custom command schema, shortcut/palette integration, audit/redaction policy.  
**Key owner paths:** `crates/protocol`, `crates/control-server`, `crates/cli`, `crates/config`, Electron main, renderer command registry.
**Acceptance:**

- [x] **M4-AC-01:** Every stable Tier A UI action has a typed action ID or a documented security/interaction exception.
- [x] **M4-AC-02:** Unauthorized, malformed, oversized, conflicting, and canceled invocations fail closed with stable errors.
- [x] **M4-AC-03:** Custom commands cannot bypass preload, shell-escaping policy, path policy, or user confirmation requirements.
- [x] **M4-AC-04:** Electron-owned actions select exactly one eligible desktop provider and target window, acknowledge completion once, cancel on caller/provider loss, and fail deterministically when no provider is leased.

**Validation:** Rust/Zod parity, authentication/authorization/backpressure tests, CLI contract tests, E2E palette/shortcut parity, and redacted diagnostics review.

### M5 — browser automation

**Dependency:** M4 and accepted browser automation threat-model ADR.
**Deliverables:** Addressable automation sessions, navigation/query/input/screenshot primitives, origin/permission policy, cancellation/timeouts, lifecycle cleanup, CLI/action integration.
**Key owner paths:** Electron main browser owner, fixed preload, `crates/control-server`, protocol and CLI.
**Acceptance:**

- [x] **M5-AC-01:** Automation never exposes Node, Electron, desktop bridge, control token, or another profile’s data.
- [x] **M5-AC-02:** Session destruction cancels pending work and returns live `WebContents` to baseline.
- [x] **M5-AC-03:** Navigation, popup, download, permission, screenshot, and external-URL policies remain enforced under automation.
- [x] **M5-AC-04:** Desktop-provider disconnect, lease expiry, window closure, and multi-window routing cannot execute an automation request twice or against the wrong browser session.

**Validation:** Deterministic browser E2E, hostile-page security tests, cancellation/race tests, console/network evidence, leak checks, and packaged smoke.

### M6 — restore and agent orchestration

**Dependency:** M2 saved layouts and M4 actions.
**Deliverables:** Explicit resumability model, agent adapters, session catalog, fork conversation, teams/subagent split coordination, hibernation metadata, honest degraded restore.
**Key owner paths:** `crates/core`, `crates/storage`, `crates/workspace-runtime`, `crates/terminal-runtime`, notification runtime, CLI, renderer.
**Status:** Implemented and independently reviewed clean against M6-AC-01 through M6-AC-04. See
[`validation/m6-agent-sessions.md`](validation/m6-agent-sessions.md). This is focused milestone
acceptance, not final candidate qualification.
**Acceptance:**

- [x] **M6-AC-01:** Restore distinguishes live reattach, tool-supported resume, layout-only restart, and unavailable session.
- [x] **M6-AC-02:** Fork creates independent durable identity and provenance without claiming process-memory cloning.
- [x] **M6-AC-03:** Team/subagent attention routes to the exact workspace, pane, tab, and session and survives restart.
- [x] **M6-AC-04:** Hibernation never silently kills uncheckpointed work; destructive choices require explicit confirmation.

**Validation:** Adapter contract tests, PTY identity/reconstruction E2E, restart/crash/corruption matrices, notification routing, and privacy review of stored conversation metadata.

### M7 — SSH and remote tmux

**Dependency:** M4 actions, M6 session model, and accepted remote trust ADR.
**Deliverables:** Remote target profiles, host-key flow, local SSH process ownership, detachable sessions, remote tmux discovery/attach/create, reconnect policy, status/attention integration.
**Key owner paths:** `crates/terminal-runtime`, `crates/workspace-runtime`, `crates/storage`, `crates/config`, control server, CLI, renderer.
**Status:** Implemented and independently re-reviewed clean against M7-AC-01 through M7-AC-03.
See [`validation/m7-remote-sessions.md`](validation/m7-remote-sessions.md). Remote browser routing and
local notification relay are not implemented and are not implied by this acceptance.
**Acceptance:**

- [x] **M7-AC-01:** Host-key changes fail closed; secrets never enter SQLite projections, renderer state, logs, or diagnostics.
- [x] **M7-AC-02:** Network loss exposes disconnected/reconnecting/detached state without fabricating local process health.
- [x] **M7-AC-03:** Detach/reconnect and remote tmux attach preserve correct target/session identity across restart.

**Validation:** Hermetic SSH/tmux fixtures, host-key and credential tests, disconnect/race recovery, CLI/E2E flows, migration tests, and security review.

### M8 — right-sidebar productivity surfaces

**Dependency:** M3 window/tab lifecycle, M4 actions, M5 browser automation, M6 session model, and M7 remote sessions.  
**Deliverables:** Dock/right sidebar, TextBox, Vault, Task Manager, file/Markdown/diff viewers, global search, recently closed, bounded indexing and preview contracts.
**Key owner paths:** `crates/core`, `crates/storage`, service/indexing boundary, Electron main, fixed preload, renderer.
**Status:** Implemented and independently re-reviewed clean against M8-AC-01 through M8-AC-04.
The packaged M8 runtime harness passes all four flows with a display and Secret Service. See
[`validation/m8-sidebar-surfaces.md`](validation/m8-sidebar-surfaces.md).
**Acceptance:**

- [x] **M8-AC-01:** Files, Markdown, diffs, search results, and recently closed items respect workspace/path authorization and untrusted-content sanitization.
- [x] **M8-AC-02:** Vault transcript indexing remains local by default, honors per-agent exclusions and retention controls, and never exposes transcript content through generic diagnostics.
- [x] **M8-AC-03:** Task Manager reports authoritative process/session state and requires confirmation for destructive actions.
- [x] **M8-AC-04:** Sidebar surfaces are resizable, keyboard complete, accessible at supported zoom, and restore safely.

**Validation:** Unit/index tests, traversal/symlink/HTML security tests, a11y and visual suites, end-to-end search/reopen/task flows, migration/recovery, and packaged evidence. Linux functional-parity implementation scope closes only after every milestone M0 through M8 is complete; qualification additionally requires all global gates.

### M9 — optional extensibility and companion platforms

**Dependency:** M8 plus feature-specific ADRs.
**Deliverables:** Project layout packages, extension-supplied declarative actions, reviewed skills/sidebar extensions, optional native macOS implementation, iOS companion, and cloud coordination boundaries.
**Key owner paths:** Config/protocol/action registry, extension host if approved, platform-specific applications and release infrastructure.
**Acceptance:**

- [ ] **M9-AC-01:** Extensions use capability-scoped declarative or isolated execution and cannot expand preload/main privileges.
- [ ] **M9-AC-02:** Project layouts are portable, versioned, reviewable, and safe to open without executing commands implicitly.
- [ ] **M9-AC-03:** Every optional platform has independent security, privacy, migration, accessibility, packaging, and support qualification before any claim.

**Validation:** Feature-specific threat models and contract suites. Native macOS, iOS, cloud, and other companion work remains non-blocking for Linux desktop parity.

## 9. Global quality and release gates

- **PAR-QUAL-001 Accessibility:** Automated axe coverage, keyboard-only flows, focus restoration, zoom/reflow, forced colors, reduced motion, screen-reader semantics, and retained human review MUST cover new surfaces.
- **PAR-QUAL-002 Keyboard:** Every primary and destructive action MUST have documented shortcuts or keyboard paths, conflict handling, and deterministic focus outcomes.
- **PAR-QUAL-003 Performance:** Startup, idle CPU/memory, PTY latency/rendering, card updates, search/indexing, browser views, window count, and restore MUST be measured against existing repository baselines. No new numeric budget is established here; regressions require evidence and an accepted decision.
- **PAR-QUAL-004 Security/privacy:** Threat models, authentication, least privilege, content sanitization, secret redaction, path confinement, dependency review, and data-retention controls MUST pass for the exact candidate.
- **PAR-QUAL-005 Migration/recovery:** Supported schema/config origins, interrupted migration, corrupt state, backups, rollback, renderer crash, service crash, and partial runtime failure MUST have retained evidence.
- **PAR-QUAL-006 Observability:** New actions MUST emit bounded structured diagnostics with correlation and stable error codes while excluding secrets, terminal content, browser content, and private metadata by default.
- **PAR-QUAL-007 Evidence:** Unit, property, protocol-generation, E2E, a11y, visual, package, and release-validation evidence MUST identify the exact commit and host.

The required command gates are:

```sh
pnpm generate:protocol
cargo test --workspace --all-features
pnpm validate
pnpm --filter @agent-workspace/desktop test:e2e
pnpm --filter @agent-workspace/desktop test:a11y
pnpm --filter @agent-workspace/desktop test:visual
pnpm --filter @agent-workspace/desktop performance:smoke
pnpm --filter @agent-workspace/desktop performance:soak
pnpm package:linux
pnpm release:validate --version <version> --mode <candidate|unreleased>
```

A milestone MAY use focused checks during development, but completion requires the applicable global commands and evidence. These commands alone do not establish qualification. The exact candidate MUST also have completed evidence records satisfying [Performance](PERFORMANCE.md), [Security model](SECURITY_MODEL.md), and [Release qualification](RELEASE_QUALIFICATION.md), including the exact soak, clean-package matrix, dependency/SBOM/provenance and security workflows, and required human accessibility and release reviews. A command or review blocked by unavailable qualification infrastructure MUST be reported as not run or blocked, never converted into a pass.

## 10. Risks and mitigations

| Risk                                            | Mitigation                                                                                             |
| ----------------------------------------------- | ------------------------------------------------------------------------------------------------------ |
| Upstream scope churn                            | Pin baselines; require a dated delta audit before adding scope.                                        |
| Renderer becomes authoritative                  | Enforce typed command/snapshot flows and domain invariant tests.                                       |
| Feature breadth destabilizes PTYs               | Preserve runtime ownership, use atomic transactions, and run same-PTY regression flows each milestone. |
| Card metadata storms degrade UI                 | Bound payloads/rates, invalidate slots independently, and measure against current baselines.           |
| Multi-window lifecycle leaks                    | Centralize main-process view/window registry and test crash/transfer races.                            |
| Action API expands attack surface               | Capability-gate, authenticate, authorize, validate, audit, and fail closed.                            |
| Automation crosses browser trust boundary       | Keep ownership in Electron main and test hostile remote content continuously.                          |
| Resume promises exceed tool support             | Publish explicit restore levels and never claim process-memory checkpointing.                          |
| Remote secrets leak                             | Use OS credential facilities, redact diagnostics, and prohibit renderer/storage exposure.              |
| Extensibility becomes arbitrary privileged code | Prefer declarative actions; isolate any execution behind approved capability policy.                   |
| Migration damages user state                    | Backup, transact, integrity-check, test every supported origin, and retain recovery UX.                |

## 11. Claim boundaries

- This document is a design and behavior roadmap, not a support, compatibility, trademark, or upstream endorsement claim.
- Completion of an implementation milestone does not establish validation or qualification.
- M0 through M8 implementation is present and focused milestone acceptance is complete. A Linux
  desktop functional-parity claim remains blocked on every applicable exact-candidate global gate.
- M9 native macOS implementation, iOS, cloud, and companion capabilities are optional and non-blocking.
- Cross-platform protocol design does not qualify a platform; retained execution evidence is mandatory.
- Similar visible outcomes do not imply source compatibility, plugin compatibility, file-format compatibility, or identical internal architecture.

## 12. Decision status

The M0–M8 boundary decisions that were deferred when this specification was written are now resolved
by accepted ADRs: action/provider/custom-command negotiation in [0008](decisions/0008-public-actions-and-desktop-provider-leases.md)
and [0009](decisions/0009-safe-project-custom-commands.md), card slots in
[0002](decisions/0002-ephemeral-workspace-card-slots.md) and
[0005](decisions/0005-bounded-rich-card-slots-v2.md), multi-window transfer in
[0007](decisions/0007-multi-window-and-tab-transfer-ownership.md), agent restore/provenance/retention
in [0011](decisions/0011-agent-session-restore-and-hibernation.md), SSH credentials/tmux in
[0012](decisions/0012-ssh-remote-session-trust.md), and indexing/Vault policy in
[0013](decisions/0013-sidebar-content-indexing-and-task-boundaries.md).

The following product or optional M9 decisions remain deferred and do not weaken M0–M8 contracts:

- Public product identity, stable package names, and final external API namespace.
- Extension execution model and whether non-declarative skills are permitted.
- Scope, identity, sync, and threat model for native macOS, iOS, or cloud work.

Each remaining deferred decision MUST be resolved by RFC/ADR before its dependent optional work
changes protocol, process, persistence, or security behavior.

## 13. Immediate next slice

The authoritative remaining-findings ledger is
[`validation/2026-07-21-m0-m8-final-candidate-audit.md`](validation/2026-07-21-m0-m8-final-candidate-audit.md).
Close its CPU, exact-candidate regression, package-matrix, soak, and human-review blockers without
converting unavailable infrastructure into a pass. Make a parity/release claim only after all
records identify the same committed candidate.

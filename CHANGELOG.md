# Changelog

All notable changes will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/). Semantic versioning
will become binding at version 1.0.

## [Unreleased]

### Added

- Independent Linux-first, cross-platform repository foundation with pnpm and Cargo workspaces,
  contribution and governance files, and automated format, lint, typecheck, test, and build gates.
- Sandboxed Electron main/preload/React renderer skeleton supervised by a Rust control service.
- Authenticated local UTF-8 NDJSON protocol with generated TypeScript DTOs and runtime Zod
  validation.
- Milestone 1 PTY runtime for spawn, input, output, resize, termination, and exit reporting.
- Single-workspace, single-pane terminal UI using xterm.js fit, search, serialize, Unicode,
  clipboard, web-links, and WebGL add-ons with canvas fallback.
- Renderer reload reconstruction from serialized checkpoints and ordered output journals.
- Terminal settings for font size, copy-on-select, search modes, and process restart.
- Protocol and terminal limits for 1 MiB control frames, 64 KiB raw output chunks, 512 KiB
  checkpoint wire payloads, bounded per-client queues, and attachment-scoped subscriptions.
- Renderer and terminal protections including a restrictive CSP, a narrow validated preload bridge,
  external URL scheme validation, multiline paste confirmation, and denied OSC 52 host clipboard
  access.
- A path-confined packaged renderer protocol, audited production Electron fuses, real-program PTY
  smoke tests, provisional performance gates, and same-PID renderer-reload Playwright coverage.
- Backend-authoritative workspaces, recursive split-pane trees, tabs, selection, ordering, pane
  ratios, terminal-per-tab ownership, and revisioned SQLite persistence.
- Complete Milestone 2 control protocol and typed Electron bridge for workspace, pane, tab,
  terminal-restart, and shortcut-setting mutations, with strict Rust/Zod DTO parity.
- Rust/Zod structural graph parity across 21 shared invalid projection vectors and authoritative
  terminal-restart error handling with retry.
- ECMAScript Unicode-trim parity across authoritative and projection validation, plus restartable
  terminal attach failures and pane-local input/resize race errors.
- Per-terminal attachment transition ordering prevents delayed cleanup from detaching a remounted
  pane after splits or workspace navigation.
- Bounded per-client mutation replay, named domain invalidations, machine-readable service
  readiness, lifecycle shutdown events, and bounded graceful connection drain.
- Multi-workspace React renderer with sortable workspaces and tabs, cross-pane moves, directional
  splits, resizable pane groups, command palette, and editing/clearing/resetting all 12 shortcuts.
- Workspace sidebar metadata for working-directory basename, bounded authoritative Git branch,
  sanitized selected-terminal process title, descendant-aware TCP listening ports, and attention,
  plus accessible context actions for rename, color, safe duplication, move, and close.
- Project-owned Tailwind/Radix UI primitives and design tokens; embedded browser metadata is shown
  as an explicit disabled placeholder pending the isolated browser-view milestone.
- Durable bounded notification history, read state, derived attention summaries, grouped center,
  bounded Sonner toasts, exact-target jump semantics, and configurable redacted system forwarding.
- Public packaged identify/notify CLI with secure ephemeral discovery, strict OSC 9/777 support,
  and explicit reversible Codex and Claude Code notification-hook installers.
- Backend-owned browser tabs rendered in isolated native `WebContentsView` instances with
  synchronized lifecycle, bounds, focus, navigation state, and explicit permission, download,
  popup, and external-navigation policy.
- SQLite schema v2 with checked durable window state, a transactional schema-v1 migration,
  owner-only pre-migration backup, rollback on failure, read-only recovery inspection, and
  data-preserving recovery export.
- Schema-v1 configuration with atomic persistence for all typed sections and a renderer settings
  surface. Appearance theme/density, terminal font family/size/scrollback/multiline-paste
  protection, and notifications hydrate and apply live. Configured default shells are validated on
  the current host and apply to future implicit terminals while existing PTYs and explicit commands
  remain unchanged. Structured logging levels now apply live after durable configuration commit.
  Browser profile/privacy and agent-integration controls remain persisted but disabled and labeled
  deferred; update controls use prevalidated feed roots.
- Bounded service restart and renderer-crash recovery flows, a recovery-required UI, owner-only
  rotating redacted logs, and an allow-listed, redacted JSON diagnostic artifact with exact preview
  approval before export.
- Path-free recovery presentation of migration-backup availability as a safe boolean, including
  availability after migration fails with a secured backup while its path remains main-process
  private.
- Expanded JSON CLI for workspace list/create, terminal create/send, and pane split operations,
  retaining owner-only session discovery and no token flag.
- Exact x86_64 AppImage, Debian, and RPM packaging with deterministic `SHA256SUMS`, artifact
  inspection/launch probes, clean-container matrices, and draft-only candidate automation.
- Explicit stable/beta `electron-updater` flow with separate trusted HTTPS roots and independent
  check, download, and install approval; default packages remain feed-free.
- Direct axe-core 4.12.1 WCAG-tagged audits across five representative desktop states without rule
  suppression, plus keyboard, reduced-motion, and terminal screen-reader-mode coverage.
- Release-build performance qualification for PTY response, launch/restore, split resize,
  proportional memory, a strict five-minute process-tree idle-CPU gate, load scenarios, and an
  opt-in exact eight-hour soak. A non-animated block cursor avoids continuous xterm repaints while
  preserving the idle terminal's visible cursor.
- Release security workflows for dependency advisories, SPDX/CycloneDX SBOMs, license inventory,
  packaged-artifact scanning, and build provenance, plus complete installation, configuration,
  shortcut, CLI, security, architecture, contributor, and known-limit documentation.
- x64 macOS DMG/zip and Windows NSIS packaging, native updater metadata and package detection,
  platform-aware command-palette E2E shortcuts, installed-package readiness probes, and native CI
  lanes for Rust, Electron, protocol, and packaging coverage.
- A manually gated signed-native candidate workflow with forced code signing, macOS notarization
  and stapling checks, Windows Authenticode verification, and no automatic publication.
- A protected Windows named-pipe DACL limited to the pipe owner and LocalSystem, while retaining
  authenticated protocol framing and remote-client rejection.

### Status

- Milestone 0 foundation work is complete.
- Milestone 1 is established on the documented Linux reference host. macOS/Windows validation,
  long-duration soak tests, installer support, and release benchmarking remain future work.
- Milestone 2 is established on the documented Linux reference host. The repository-wide
  validation and packaged trust gates remain green.
- Milestone 3 is established on the documented Linux reference host. The validation gate passes
  with 114 Rust protocol tests, 39 protocol-client tests, and 177 desktop tests; the integrated
  Playwright Electron suite passes 4/4, including targeted notification jump/read behavior and a
  bounded 30-notification storm. Cross-platform validation remains future work.
- Milestone 4 is established on the documented Linux reference host. Isolated browser privilege,
  navigation, popup, bounds, screenshot, and bounded create/destroy coverage passes.
- Milestone 5 is established on the documented Linux reference host. Its repository validation,
  production build, and primary 4/4 recovery Electron suite passed at establishment. Independent browser
  validation repeated its original 4/4 flow twice and passed persistence, service and renderer
  recovery, corrupt-database privacy/export/diagnostics, console, and viewport checks. macOS,
  Windows, release-candidate packaging publication, long soak, and stable migration claims remain
  future work.
- Milestone 6 is in validation. Required release PTY, PSS, and idle-CPU smoke gates pass locally;
  direct axe coverage is clean across five states. The latest packaged five-minute idle window
  averaged 0.8893% process-tree CPU after a five-minute settle. The hosted update feeds, signing
  identity, public homepage/repository and finalized public identity, published artifacts, GitHub
  clean-install/security evidence, human assistive-technology checks, and exact eight-hour soak
  remain open. The 2026-07-18 soak attempt was intentionally stopped after about 3 hours 8 minutes,
  produced no JSON report, and is recorded as deferred rather than passed. No stable release or
  support guarantee is claimed.
- Milestone 7 is in validation at the configuration layer. Native packaging, update metadata,
  E2E/install probes, signing workflow, and Windows pipe ACL hardening are implemented, but no
  retained macOS or Windows runner result or signed artifact exists yet.

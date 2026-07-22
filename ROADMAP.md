# Roadmap

This roadmap summarizes the milestones defined in
[the implementation specification](docs/IMPLEMENTATION_SPEC.md). It is a sequencing document, not
a release-date promise. The project is Linux-first and designed for a shared macOS and Windows
codebase; platform release validation follows the Linux release candidate.

Status terms describe repository state only:

- **Established:** the milestone's deliverables and exit criteria have been satisfied.
- **Validation:** implementation exists, but one or more exit criteria remain open.
- **Planned:** work belongs to a later milestone and is not claimed by the current implementation.

## Milestone 0: Foundation — established

Repository and governance files, pnpm and Cargo workspaces, the Electron
main/preload/renderer skeleton, Rust service skeleton, authenticated local handshake, generated
TypeScript protocol types, and CI quality gates are present. The Linux development application can
identify the service and the renderer security configuration has automated coverage.

## Milestone 1: Single terminal — established

PTY spawn/input/output/resize/exit, xterm.js with fit and WebGL fallback, one
workspace/pane/terminal tab, basic terminal settings, and checkpoint-plus-journal reconstruction
are implemented. Real-PTY smoke tests pass for installed Bash, Zsh, and Neovim; unavailable Fish,
Vim, and tmux are reported as skips. Automated and packaged Electron validation retains the exact
terminal ID/PID across renderer reload and reconstructs visible output without new PTY input.
Warmed input, resize, and input-to-output p95 measurements pass the provisional Linux targets.

This status is Linux-specific. Cross-platform program coverage, soak testing, accessibility, and
release benchmarking remain in the later platform and release-candidate milestones.

## Milestone 2: Workspaces, tabs, and splits — established

The backend-owned domain model, durable SQLite projection, sidebar and workspace management,
recursive pane tree, multiple tabs, pointer/keyboard reorder and directional split actions, command
registry and palette, and all 12 keyboard-shortcut settings are implemented. Sidebar rows include
the working-directory basename, a bounded authoritative Git-branch lookup, selected terminal
process-title metadata, a native descendant-aware TCP listening-port summary, and derived
attention. Their accessible pointer/keyboard context menu
provides rename, validated color, safe metadata duplication, move, and close actions through the
existing domain mutations. Property-oriented tree tests, persistence/revision tests, Rust/Zod
structural graph parity tests, strict repository validation, renderer interaction suites,
exact-same-PTY reload reconstruction, and the integrated 3/3 Playwright Electron suite pass. The
rebuilt unpacked Linux package also passes secure-fuse, bundled-service trust, owner-only socket,
real-PTY, workspace, terminal-marker, and split checks without renderer errors. This established
status is specific to the documented Linux reference host; cross-platform validation remains in
Milestone 7.

## Milestone 3: Notifications and agents — established

Notification persistence/read state, the grouped center, derived attention at every workspace
target level, bounded toasts, optional redacted system notifications, the public identify/notify
CLI, strict OSC 9/777 parsing, secure ephemeral discovery, and reversible Codex/Claude Code hook
installers are implemented. Unit, persistence, protocol, and hook tests pass; the real-service
Electron flow proves identify, targeted notification, exact-tab jump followed by read transition,
and a bounded 30-notification storm. This established status remains Linux-specific.

## Milestone 4: Browser panes — established

Backend-owned browser tabs, isolated `WebContentsView` instances, lifecycle and bounds/focus
synchronization, address and history controls, devtools access, and permission, download, popup,
and external-navigation policies are implemented. The deterministic Electron suite proves remote
pages have no Node, Electron, preload, or desktop-bridge privileges; native history navigation and
same-origin popup disposition work; and repeated create/destroy cycles return to the baseline live
`WebContents` count. This established status is specific to the documented Linux reference host.

## Milestone 5: Persistence and recovery — established

SQLite schema v2 adds durable checked window state and migrates schema v1 transactionally after
creating an owner-only SQLite backup; failures retain that backup and roll the source back. The
schema-v1 persistence for all typed configuration sections, a settings UI, bounded rotating
redacted logs, exact-preview allow-listed and redacted JSON diagnostic export, supervisor restart
flow, renderer-crash reload, and corrupt-database recovery UI are implemented. Appearance,
terminal font/rendering and paste-protection fields, and notifications apply live. A configured
default shell is host-validated and applies to future implicit terminal launches without replacing
existing PTYs or explicit commands. The structured-log filter is reloadable, so persisted level
changes affect subsequent service events immediately after the configuration transaction. Browser
profile/privacy and agent-integration controls are persisted but disabled and labeled deferred
until runtime owners exist; update controls select only prevalidated feed roots. Healthy database
exports use a WAL-consistent SQLite backup. Unusable databases export the exact main-file bytes as
recovery evidence without merging WAL sidecars. Recovery UI exposes migration-backup availability
as a safe boolean while the path stays private to the main process; failure after a secured backup
reports availability without exposing the path.

The repository-wide validation gate and production build passed at establishment. The primary
Electron recovery suite passed 4/4. Independent browser validation repeated its original 4/4 flow
twice and confirmed
durable layout, configuration, and window placement; service `SIGKILL` recovery with a replacement
service and PTY; renderer-crash recovery with the same service and PTY; and private, source-
preserving corrupt-database diagnostics/export. This established status is specific to the
documented Linux reference host.

## Milestone 6: Linux release candidate — validation

The repository now defines exact x86_64 AppImage, Debian, and RPM packaging with deterministic
checksums; a feed-free default build; explicit stable/beta updater state management behind two
trusted HTTPS roots; expanded public CLI commands; direct axe-core coverage across five desktop
states; release-build PTY/PSS performance gates; and package, security, SBOM, provenance,
performance, and draft-only release workflows. End-user, operator, security, and contributor
manuals cover the implemented surfaces and their limits.

The milestone is not established. No hosted feeds, signing keys, or published release exist. The
temporary `.invalid` packaging homepage must be replaced with a real project-owned URL and
maintainer identity, and the current original project icon still requires maintainer approval. The
exact artifact set and clean Ubuntu/Fedora install matrix still require GitHub execution evidence;
the repository currently has no commit/remote from which to run those workflows. The latest local
packaged smoke passed the strict five-minute process-tree idle-CPU gate at 0.8893% after a five-minute
settle. Automated axe covers dark and light appearances, and packaged Electron checks now exercise
keyboard operation and reflow at effective 200% and 400% zoom plus Chromium forced colors with
system-color focus evidence. Human assistive-technology and light-theme review, native OS
zoom/high-contrast qualification, and the exact eight-hour soak remain open. The 2026-07-18 local
attempt was intentionally stopped after about 3 hours 8 minutes and produced no JSON report, so it
is deferred rather than passed; implementation completion yields a release candidate until a later
final-code soak and manual trend review succeed. Thirteen fixed-viewport Linux visual baselines
additionally cover the blank final-workspace replacement, interaction and
pane-layout variants, corrupt-database recovery, generic bundled-service startup failure, and a
deterministic DPR 1.25 renderer pass. Native compositor and native-platform visual matrices remain
qualification work.
All 1.0 acceptance criteria and zero unresolved critical/high security findings remain exit gates.
See [known limitations](docs/KNOWN_LIMITATIONS.md).

## Milestone 7: macOS and Windows — in validation

Native DMG/zip and NSIS packaging, updater package detection and metadata builds, platform E2E and
installed-package probes, a gated signing/notarization workflow, and a protected Windows pipe DACL
are implemented. Retained macOS/Windows workflow runs must still establish ConPTY, protocol,
signing/notarization, shortcut, menu, filesystem, notification, and credential-store behavior.
Platform end-to-end suites and identical protocol conformance remain the exit gates.

## Version 1.0

Version 1.0 follows the Linux release-candidate acceptance criteria in the implementation
specification. No current milestone status implies a stable release, compatibility guarantee, or
supported performance claim.

# Known limitations

Milestones 6, 7, and 8 are implemented and independently reviewed against their focused acceptance
criteria. Exact-candidate qualification is still pending. This repository does not publish a stable
release or support guarantee.

- No public download, hosted stable/beta update feeds, release signing key, or published release
  exists. Default packages are feed-free and updater use requires two distinct trusted HTTPS roots.
- The public name and `agent-workspace` slug are temporary. The packaging homepage is currently a
  reserved `.invalid` placeholder for local qualification; release validation rejects it until a
  real project-owned repository/domain and maintainer identity are selected. The current original
  icon is a temporary project asset and may change with the public identity.
- AppImage, deb, rpm, deterministic `SHA256SUMS`, package/install workflows, SBOMs, vulnerability
  gates, and draft-only release automation are defined. The latest local exact-artifact matrix
  passed clean Ubuntu 24.04 deb/AppImage and Fedora 42 rpm install-and-launch probes. GitHub
  workflows have not been executed in this repository state and remain a release gate.
- Linux is the only currently validated desktop target. macOS DMG/zip and Windows NSIS packaging,
  native update metadata, installed-package launch probes, native E2E jobs, and a gated signed
  release workflow are implemented. The Windows pipe now has a protected owner/LocalSystem DACL.
  None of those workflows has executed on a retained native runner, so ConPTY, signing/notarization,
  menu/filesystem/notification/credential-store behavior, and platform shortcuts remain
  qualification gates. ARM64 is not packaged.
- Release PTY, one-/ten-terminal PSS, and five-minute process-tree idle CPU gates passed the latest
  local packaged smoke; idle CPU averaged 0.8893% after a five-minute settle. Cold/warm launch and
  resize measurements are informational. The exact eight-hour soak has not run, and no maintained
  approved cross-host baseline is claimed.
- Direct axe-core 4.12.1 found no WCAG-tagged violations in representative dark and light states
  with no rule suppression. Thirteen fixed-viewport Linux visual baselines cover both appearances,
  the blank final-workspace replacement, interaction and pane-layout variants, corrupt-database
  recovery, generic bundled-service startup failure, and a DPR 1.25 renderer pass. Native
  compositor fractional scaling and native-platform matrices remain open. Automated Electron
  qualification covers Chromium 200%/400% zoom reflow and forced-colors focus/semantics. No human
  screen-reader or light-theme session, native OS high-contrast/zoom usability review, or full
  extreme-resize keyboard-order sweep has been completed. Per-terminal screen-reader mode is not
  persisted.
- Arbitrary content inside embedded browser pages is outside the app renderer's accessibility
  audit. Native Wayland, XWayland, GPU/compositor combinations, browser site compatibility,
  downloads, permissions, and real-user desktop notifications need broader host coverage.
- Browser profile/privacy controls remain persisted but deferred. Update channel selection is live only when trusted feeds are
  configured. Copy-on-select and screen-reader mode are session-local controls.
- There is no plugin execution surface or third-party main-process extension mechanism.
- Remote SSH/tmux sessions are implemented, including native host-key/credential handling and
  reconnect identity. Remote browser routing and local-notification relay are not implemented.
- The eight M8 sidebar surfaces and their packaged Electron harness are present. Runtime execution
  of that M8 harness is deferred to the exact final candidate and requires a live display plus
  Secret Service session; this is not yet an E2E pass. Focused unit, protocol,
  control, preload/main, renderer, and typecheck evidence does not substitute for final visual,
  accessibility, performance, package, or human assistive-technology qualification.
- Storage/configuration formats and temporary identifiers remain pre-1.0 interfaces without a
  public stable migration or compatibility guarantee.

See [Installation](INSTALLATION.md), [Accessibility](ACCESSIBILITY.md),
[Performance](PERFORMANCE.md), [Updates](UPDATES.md), and [Releasing](RELEASING.md) for exact
qualification boundaries.

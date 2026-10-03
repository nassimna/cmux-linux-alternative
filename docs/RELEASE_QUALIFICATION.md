# Release qualification record

Copy this template for each release candidate and store the completed record with the retained
release evidence. This file is a template, not evidence that any check has passed.

Use only these status values: `PASS`, `FAIL`, `NOT RUN`, and `NOT APPLICABLE`. Every `PASS` needs a
durable evidence link. `NOT APPLICABLE` needs a release-scope rationale. Every pre-publication
required check marked `FAIL` or `NOT RUN` blocks publication. Section 24 criterion 10 and the
publication-record fields are post-publication closeout: they remain `NOT RUN` before publication,
must become `PASS` immediately afterward, and block a completed 1.0 qualification until then. A
closeout failure requires rollback. Do not use a local `/tmp` path, an unretained workflow log, or an
unsigned verbal assertion as durable evidence.

A deferred or interrupted soak remains `NOT RUN` even when its partial progress log is retained.
Closing an implementation milestone may produce a release candidate, but it does not waive the
exact-eight-hour report, deterministic analysis, and manual bounded-growth review required before
publication.

## Candidate metadata

| Field                         | Recorded value |
| ----------------------------- | -------------- |
| Version                       |                |
| Tag                           |                |
| Commit SHA                    |                |
| Channel (`stable` or `beta`)  |                |
| Release scope                 |                |
| Qualification start/completed |                |
| Linux build host              |                |
| Display server/compositor/GPU |                |
| Power profile and other load  |                |
| Primary reviewer              |                |
| Second maintainer             |                |

## Source, artifacts, and supply chain

| Required check                                           | Status | Evidence | Notes or N/A rationale |
| -------------------------------------------------------- | ------ | -------- | ---------------------- |
| Version, exact tag, and changelog gate                   |        |          |                        |
| Clean-checkout `pnpm validate`                           |        |          |                        |
| AppImage, deb, rpm, and exact `SHA256SUMS` set           |        |          |                        |
| Ubuntu deb clean install and packaged launch             |        |          |                        |
| Ubuntu extracted AppImage inspection and packaged launch |        |          |                        |
| Fedora rpm clean install and packaged launch             |        |          |                        |
| Arch Linux extracted AppImage inspection and X11 launch  |        |          |                        |
| Build provenance for every published artifact            |        |          |                        |
| SPDX and CycloneDX SBOMs                                 |        |          |                        |
| Production dependency license inventory                  |        |          |                        |
| pnpm audit and packaged Grype high/critical gates        |        |          |                        |
| Zero unresolved critical/high security findings          |        |          |                        |

## Performance and stability

Follow [Performance qualification](PERFORMANCE.md). Retain both the source report and the analyzer
output; the analyzer is descriptive and cannot approve bounded growth by itself. Run the documented
exact-eight-hour command later against the unchanged final-code candidate; an interrupted run with
no validated JSON leaves every soak row below at `NOT RUN`.

| Required check                                       | Status | Evidence | Notes or N/A rationale |
| ---------------------------------------------------- | ------ | -------- | ---------------------- |
| Release-build smoke report and required metric gates |        |          |                        |
| Exact eight-hour report, 481 aligned samples         |        |          |                        |
| Deterministic soak analysis output                   |        |          |                        |
| Manual bounded-growth verdict and reviewer rationale |        |          |                        |
| No OOM, renderer restart, or service restart in soak |        |          |                        |
| Extracted AppImage software-rendering fallback       |        |          |                        |
| Headless native-Wayland renderer/service readiness   |        |          |                        |
| Wayland and X11 launch/input/focus comparison        |        |          |                        |
| Native compositor/GPU visual and input-feel review   |        |          |                        |

Manual bounded-growth rationale:

> Record why the complete chronological PSS series is bounded, including late-run behavior and any
> allocator or workload variation. Record any contrary evidence instead of approving the run.

## Accessibility and native interaction

Follow [Accessibility evidence](ACCESSIBILITY.md). Automated Chromium zoom and forced-colors checks
do not replace native operating-system or human assistive-technology review.

| Required check                                          | Status | Evidence | Notes or N/A rationale |
| ------------------------------------------------------- | ------ | -------- | ---------------------- |
| Direct axe and visual regression suites                 |        |          |                        |
| Keyboard-only primary workflow and complete focus sweep |        |          |                        |
| Human screen-reader workflow                            |        |          |                        |
| Human dark/light theme and contrast review              |        |          |                        |
| Native OS zoom and high-contrast review                 |        |          |                        |
| Extreme resize, IME, Unicode, selection, and mouse flow |        |          |                        |
| Native file dialogs, menus, notifications, and links    |        |          |                        |

## Native macOS and Windows qualification

For a Linux-only 1.0 candidate, a native-platform row may be `NOT APPLICABLE` only when the release
scope explicitly excludes that platform. A macOS or Windows artifact must never be published from a
record that marks its platform checks `NOT RUN` or `NOT APPLICABLE`.

| Required check                                           | Status | Evidence | Notes or N/A rationale |
| -------------------------------------------------------- | ------ | -------- | ---------------------- |
| macOS protocol/Electron end-to-end suite                 |        |          |                        |
| macOS DMG/zip install, launch, menu, shortcuts, storage  |        |          |                        |
| macOS Developer ID signature, notarization, and stapling |        |          |                        |
| macOS notification and credential-store behavior         |        |          |                        |
| Windows protocol/Electron end-to-end suite               |        |          |                        |
| Windows ConPTY and protected named-pipe DACL             |        |          |                        |
| Windows NSIS install, launch, menu, shortcuts, storage   |        |          |                        |
| Windows Authenticode signature                           |        |          |                        |
| Windows notification and credential-store behavior       |        |          |                        |

## Identity, updates, and publication readiness

| Required check                                            | Status | Evidence | Notes or N/A rationale |
| --------------------------------------------------------- | ------ | -------- | ---------------------- |
| Independent public name, slug, package scope, and env key |        |          |                        |
| Project-owned HTTPS homepage and reverse-DNS app ID       |        |          |                        |
| Project-owned icon approval and required sizes            |        |          |                        |
| Maintainer identity, governance, DCO, and support policy  |        |          |                        |
| Real stable/beta feed origin and retained endpoint probe  |        |          |                        |
| Update metadata matches every hosted artifact             |        |          |                        |
| Signing keys protected and verification documented        |        |          |                        |
| Draft release remains unpublished pending approval        |        |          |                        |

## Version 1.0 acceptance criteria

Each row maps directly to §24 of the [implementation specification](IMPLEMENTATION_SPEC.md). Use the
most specific retained workflow, test, package, or manual evidence available.

| #   | Acceptance criterion                                                                                            | Status | Evidence | Notes or N/A rationale |
| --- | --------------------------------------------------------------------------------------------------------------- | ------ | -------- | ---------------------- |
| 1   | New user installs and launches Linux without development tooling                                                |        |          |                        |
| 2   | Workspace create, rename, reorder, select, and close                                                            |        |          |                        |
| 3   | Terminal tabs move, select, split, resize, and close by keyboard or pointer                                     |        |          |                        |
| 4   | Shell/TUI compatibility and same-PTY renderer reconstruction                                                    |        |          |                        |
| 5   | Agent/CLI notification identifies and jumps to the exact target tab                                             |        |          |                        |
| 6   | HTTPS browser navigation exposes no Electron privileges                                                         |        |          |                        |
| 7   | Layout, directories, URLs, settings, and read state restore                                                     |        |          |                        |
| 8   | Public CLI identity, workspace, terminal, split, input, and notify commands                                     |        |          |                        |
| 9   | Domain, protocol, UI, and packaged-smoke automated coverage                                                     |        |          |                        |
| 10  | AppImage, deb, and rpm published with checksums and changelog (post-publication closeout)                       |        |          |                        |
| 11  | Accessibility baseline and security checklist                                                                   |        |          |                        |
| 12  | Installation, configuration, shortcuts, CLI, architecture, contribution, security, and limitation documentation |        |          |                        |

## Findings, exceptions, and approval

| Finding or exception | Severity | Owner | Resolution or expiry | Evidence |
| -------------------- | -------- | ----- | -------------------- | -------- |
|                      |          |       |                      |          |

Any exception needs a named owner, written scope, expiry, and reviewer approval. Critical or high
security findings cannot be excepted for publication.

| Approval                         | Name | Date | Decision and evidence |
| -------------------------------- | ---- | ---- | --------------------- |
| Primary maintainer qualification |      |      |                       |
| Second maintainer qualification  |      |      |                       |
| Security approval                |      |      |                       |
| Publication approval             |      |      |                       |

## Publication or rollback record

| Field                                                        | Recorded value |
| ------------------------------------------------------------ | -------------- |
| Draft release URL                                            |                |
| Published release URL and timestamp                          |                |
| Published artifact/checksum manifest                         |                |
| Stable/beta feed URL and endpoint evidence                   |                |
| Rollback required                                            |                |
| Rollback notice, replacement version, and preserved evidence |                |

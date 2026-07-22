# Accessibility baseline

This document records the current evidence for the desktop renderer against
`IMPLEMENTATION_SPEC.md` §12.13. It is an engineering audit, not a claim of
formal WCAG conformance or a completed human assistive-technology review.

## Reference environment

- Audit date: 2026-07-17
- Linux desktop renderer under Electron 43.1.1
- Playwright 1.61.1 driving a fresh isolated Electron profile
- axe-core 4.12.1, WCAG 2 A/AA, WCAG 2.1 A/AA, and WCAG 2.2 AA tags
- Explicit dark and light appearance for axe and visual regression, default density, and the real
  local Rust service

The maintained `@axe-core/playwright` wrapper was evaluated first, but its
`analyze()` implementation creates a new browser page. Playwright's Electron
context rejects that operation with `Target.createTarget: Not supported`.
The test therefore injects the same pinned `axe-core` engine directly into the
existing Electron renderer page. No rules, impacts, nodes, or serious/critical
violations are suppressed.

## Automated evidence

Run from the repository root:

```sh
pnpm install
pnpm --filter @agent-workspace/desktop test:a11y
pnpm --filter @agent-workspace/desktop test:visual
pnpm --filter @agent-workspace/desktop exec playwright test e2e/persistence-recovery.spec.mjs --workers=1 --timeout=30000 --grep='corrupt database enters private recovery UI without mutating the source'
pnpm --filter @agent-workspace/desktop test
pnpm --filter @agent-workspace/desktop typecheck
```

Electron requires an available X11 or Wayland display. Set
`AGENT_WORKSPACE_EVIDENCE_DIR` to retain screenshots somewhere other than the
default `/tmp/agent-workspace-m6-accessibility` directory.

The accessibility E2E test audits all WCAG-tagged axe violations, not only
serious and critical impacts, in these deterministic states:

- fresh isolated profile after the initial workspace and terminal connect;
- split workspace with tabs and a keyboard-adjustable separator;
- command palette with combobox/listbox active-descendant behavior;
- settings dialog and ordered form controls;
- warning notification attention plus the notification dialog.

It also exercises keyboard focus for the workspace list, tab list, separator,
palette, settings, and notification dialog; checks reduced-motion computed
styles; verifies warning attention has a count, severity, and title rather than
color alone; verifies the selected workspace exposes semantic working-directory and runtime-metadata
names, including `no listening ports` instead of an em dash; and toggles terminal screen-reader mode
from its default-off state.
An additional Electron qualification sets the renderer to effective 200% and
400% zoom, checks horizontal reflow and keyboard operation of Settings, and
captures both states. It then emulates Chromium forced colors, verifies the
media state and a two-pixel system-color focus outline, audits the Settings
dialog, and captures the result. These are deterministic Chromium engineering
checks, not substitutes for native OS high-contrast or human usability review.

The Linux visual-regression suites drive the same packaged-style harness at a fixed 1200×800 CSS
viewport. Thirteen project-owned baselines cover split workspaces in dark and light appearance, the
blank one-pane/one-terminal replacement created after closing the final workspace, selected plus
hovered/focused controls, expanded and collapsed sidebars, one-, two-, and four-pane layouts, the
command palette, settings, notification attention and history, corrupt-database recovery, generic
bundled-service startup failure, and deterministic DPR 1.25 renderer output. The primary
workspace-state test hides terminal glyphs, process IDs, notification clock text, and the randomly
generated isolated-profile directory basename; it also removes runtime metadata whose
branch/process/listener values depend on local runtime discovery. Hiding the directory preserves its
layout, while removing the runtime metadata prevents those nondeterministic values from shifting the
workspace row. The DPR 1.25 case hides only the terminal, process, and clock regions. The surrounding
layout, terminal canvas, dialog stacking, failure/recovery controls, and other app-owned controls
remain compared. Update these reviewed source assets intentionally with
`pnpm --filter @agent-workspace/desktop test:visual:update`; the recovery baseline is owned by its
focused persistence test and should only be regenerated with that test selected.

## §12.13 checklist

| Requirement                                                            | Evidence                                                                                                                                                                                                                                                                                                                                           | Status / limit                                                                                                                                                  |
| ---------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Interactive elements are keyboard reachable                            | Playwright focuses and operates core lists, tabs, dialog triggers, palette, settings fields, notification dialog, and separator. Existing Vitest interaction tests cover roving focus and shortcuts.                                                                                                                                               | Automated representative coverage passes. A full manual Tab sweep at every window size remains recommended.                                                     |
| Focus order matches visual order                                       | The E2E test verifies Theme → Density order and composite Home/arrow navigation. Radix dialogs provide focus trapping and restoration.                                                                                                                                                                                                             | Representative automated evidence; full visual-order comparison remains manual.                                                                                 |
| Menus, dialogs, tabs, lists, and separators expose correct semantics   | axe runs in initial, split, palette, settings, and notification states. Workspace rows use list/listitem semantics and expose working-directory plus branch/process/listener metadata names; the empty listener state is asserted as `no listening ports`. Tabs are direct tablist children; auxiliary tab actions use a separate labeled toolbar. | Automated axe audit passes. Dropdown menus not present in the deterministic scenario still need a manual spot check when added to a user flow.                  |
| Attention is not communicated by color alone                           | Notification test asserts the accessible unread count, `warning` severity, and title; the visible badge also carries a count and marker.                                                                                                                                                                                                           | Automated representative evidence passes.                                                                                                                       |
| Text and controls meet WCAG AA contrast targets                        | axe color-contrast and WCAG 2.2 target-size rules run without exclusions across explicit dark and light representative states. Focused fixes cover terminal status text, command palette, settings, and compact controls. Chromium forced-colors emulation checks visible system-color focus and Settings semantics.                               | Passes in the reference dark and light environments, with automated Chromium forced-colors engineering coverage. Native OS high-contrast review remains manual. |
| Reduced motion disables nonessential movement                          | The reduced-motion media query disables animation and shortens transitions globally; Playwright emulates reduced motion and checks the loading indicator and transition duration.                                                                                                                                                                  | Automated computed-style check passes.                                                                                                                          |
| Screen-reader announcements avoid repeated high-volume terminal output | xterm screen-reader DOM output is off by default. When explicitly enabled, xterm 6 provides its own high-volume suppression announcement (`tooMuchOutput`).                                                                                                                                                                                        | Default-safe behavior is automated. A real high-volume NVDA/VoiceOver/Orca session has not been performed.                                                      |
| Terminal screen-reader mode remains user controlled                    | Each terminal toolbar exposes a `Screen reader mode` checkbox. Unit and E2E tests verify default off and live on/off control of xterm's `screenReaderMode` option.                                                                                                                                                                                 | Passes. The renderer-only choice is intentionally not persisted and resets when the terminal pane remounts because the current protocol has no setting for it.  |

## Manual checks still required

No human screen-reader audit was performed for this baseline. Before claiming
assistive-technology support, test the packaged application with NVDA on
Windows, VoiceOver on macOS, and Orca on Linux, including terminal output bursts,
selection, search, and dialog focus restoration. Automated Chromium 200%/400%
zoom and forced-colors checks now pass, but native OS zoom/high-contrast usability
and keyboard order after extreme pane resizing still require manual inspection.

The embedded browser's remote page content is outside the renderer axe audit;
the app-owned browser toolbar and host semantics are covered by their component
tests, but arbitrary web content must provide its own accessibility.

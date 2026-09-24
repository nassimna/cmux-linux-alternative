# Agent Workspace

> Working title: `agent-workspace` is a centralized temporary slug, not a selected public name.

Agent Workspace is an independent, clean-room desktop workspace for terminal-driven development
sessions. It does not copy another product's source, assets, identity, or trademarks. Development
and validation are Linux-first; the Electron, TypeScript, and Rust boundaries now include native
macOS and Windows packaging and test lanes without claiming those platforms are qualified.

This is pre-alpha software. Milestones 0–5 are established on the documented Linux reference host.
Milestone 6 release-candidate work is implemented in substantial part but remains in validation;
there is no published download, signed stable release, or public support guarantee.

## What works

- Backend-authoritative workspaces, recursive split panes, tabs, real PTYs, durable SQLite state,
  configuration, notifications/attention, recovery, renderer reload reconstruction, and sidebar
  metadata for working directory, Git branch, selected process, and listening ports.
- Sandboxed Electron UI with xterm.js terminals and isolated native browser views that receive no
  Node, preload, or desktop-bridge privileges.
- Visible workspace pins and saved SSH workspaces that launch OpenSSH with an existing alias, key,
  or host configuration.
- Searchable command palette, editable shortcuts, keyboard navigation, appearance/terminal/
  notification settings, and explicit stable/beta update controls.
- Authenticated local protocol and packaged JSON CLI for workspace list/create, terminal
  create/send, pane split, identify, notifications, and reversible agent hooks.
- Exact x86_64 AppImage, deb, and rpm packaging with deterministic `SHA256SUMS`; feed-free default
  packages; explicit user-approved update check, download, and install state transitions.
- Configured x64 macOS DMG/zip and Windows NSIS packages, native updater detection, platform E2E and
  installed-package launch workflows, and a protected Windows named-pipe DACL. Native runs and
  signed artifacts remain required before support claims.
- Locally runnable release-build accessibility and performance suites, plus pinned package,
  security, SBOM, provenance, and clean-container workflow definitions. The release-candidate
  workflow enforces direct accessibility and visual validation; performance qualification is a
  separate workflow, and native and manual gates remain unrun.

Current limitations matter: package publication metadata and signing are unresolved, the public
name and identity are still temporary, the hosted dual update feeds do not exist, GitHub release
workflows have not run in this repository state, and the eight-hour soak and human
assistive-technology checks remain open. Read [Known limitations](docs/KNOWN_LIMITATIONS.md) before
evaluating support. The 2026-07-18 local soak attempt was intentionally stopped after about 3 hours
8 minutes and produced no report; it is explicitly deferred, not passed. Implementation completion
therefore yields a release candidate until the documented exact-eight-hour run and manual trend
review succeed.

## User documentation

- [Installation and uninstall](docs/INSTALLATION.md)
- [Configuration](docs/CONFIGURATION.md)
- [SSH workspaces](docs/SSH_WORKSPACES.md)
- [Keyboard shortcuts](docs/SHORTCUTS.md)
- [CLI reference](docs/CLI.md)
- [Agent integrations](docs/AGENT_INTEGRATIONS.md)
- [Accessibility evidence](docs/ACCESSIBILITY.md)
- [Desktop updates](docs/UPDATES.md)

## Engineering documentation

- [Architecture](docs/ARCHITECTURE.md) and [protocol](docs/PROTOCOL.md)
- [Security model](docs/SECURITY_MODEL.md) and [security policy](SECURITY.md)
- [Performance qualification](docs/PERFORMANCE.md)
- [Release process](docs/RELEASING.md) and [qualification record](docs/RELEASE_QUALIFICATION.md)
- [Implementation specification](docs/IMPLEMENTATION_SPEC.md),
  [milestone completion audit](docs/IMPLEMENTATION_MILESTONE_AUDIT.md), and [roadmap](ROADMAP.md)
- [Contributing](CONTRIBUTING.md) and [dependency record](docs/DEPENDENCIES.md)

## Local development

Requires Node.js 22.20 or newer, pnpm 10.34.5, Rust 1.96.0, and Electron's Linux development
libraries.

```sh
corepack enable
pnpm install
pnpm generate:protocol
pnpm dev
```

Run the repository gate with `pnpm validate`. Focused commands and packaging/qualification steps
are documented in [CONTRIBUTING.md](CONTRIBUTING.md). Test totals change as coverage grows, so the
status does not use a stale count as a quality claim.

The latest local release performance evidence passed every required smoke gate: aggregate PSS was
307.20 MiB for one terminal (limit 350 MiB) and 331.72 MiB for ten terminals (limit 700 MiB), while
the packaged process tree averaged 0.8893% CPU during a five-minute idle window after a five-minute
settle (strict limit below 1%). Cold/warm launch and resize passed their informational targets. This
was a smoke run, not the unrun eight-hour soak; see [Performance](docs/PERFORMANCE.md).

## License

GPL-3.0-or-later. See [LICENSE](LICENSE) and [NOTICE](NOTICE).

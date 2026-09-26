# Supported features

Agent Workspace is a Linux x86_64 desktop app with an Electron shell, React UI, and a separate
Node.js/Hono service. The application, backend, CLI, and shared contracts use TypeScript. The
AppImage bundles Node and its native dependencies; Rust is not required to build or run it.

| Area | Features |
| --- | --- |
| Workspaces | Open local folders; saved SSH workspace launches; workspace selection, rename, pin, reorder, groups, and multi-selection. |
| Terminals | Real local PTYs; configurable shell, font and appearance; terminal input, resize, search, split panes, restart, and renderer reconnection. |
| Windows and tabs | Multiple windows; tab selection, duplication, move and detach; window rehome; focus history; eligible recently closed tabs. Live agent/remote bindings follow transferred tabs. |
| Layouts | Save, apply, import and export layouts in a single hosted window. Applying a layout creates fresh runtimes. |
| Managed SSH | Enroll and replace Ed25519 credentials in Secret Service; explicit host-key trust; tmux discovery, session creation, reconnect, detach and close. Requires tmux 3.2+ on the remote host. |
| Codex sessions | Register an exact existing thread; assess restore support; reattach/resume; fork conversations; hibernate eligible verified sessions. Requires a supported authenticated Codex CLI. |
| Agent organization | Session catalog, teams and members, attention/status, exact-tab navigation, and task actions with confirmation where required. |
| Agent hooks | Codex and Claude notification hooks and reversible hook setup. Claude can run in a terminal; durable session lifecycle actions currently use the Codex adapter. |
| Files and documents | Workspace file browsing, text read/save, editable TextBox documents, Markdown preview, and diff views. |
| Vault and search | Encrypted local index, explicit source consent, search and cancellation, rebuild, exclude, forget, and confirmed source export. Requires an unlocked Secret Service wallet. |
| Embedded browser | Isolated native browser views, address navigation, back/forward, reload/stop, developer tools, open externally, and authenticated browser automation with attachment approval. |
| Notifications and sidebar | Workspace attention, notification history/read state, configurable notifications, sidebar placement/cards, and process/Git/port metadata. |
| Settings and navigation | Theme, density, fonts, terminal preferences, editable keyboard shortcuts, searchable command palette, and keyboard navigation. |
| Recovery and diagnostics | Service restart, persisted workspace recovery, diagnostics preview/export, recovery export, and a pre-Node backup for existing profiles. |
| CLI and actions | Installed `agent-workspace-cli` uses the same authenticated service for workspace, terminal, organization, layout, content, search, agent, remote, notification and action operations. Run `--help` for exact commands. |
| Updates | Update controls exist for configured trusted feeds. The local installation does not provide a hosted update feed or a signed public release. |

## Boundaries

- Linux x86_64 is the current target; Windows, macOS and ARM64 are not qualified by this port.
- Generic tab close is refused while an agent/remote catalog record is bound to that tab;
  use the session lifecycle controls. This prevents dangling records.
- Managed SSH uses unencrypted Ed25519 OpenSSH keys at enrollment. Private key bytes stay out
  of the renderer and workspace database. Remote browser routing and notification relay are
  not implemented.
- Remote tmux detach/reconnect requires sessions to survive without a client. On the remote host,
  keep `destroy-unattached` and `exit-unattached` off; enabling either can end the session or
  server when Agent Workspace detaches.
- Provider restore/fork/hibernate depend on actual provider evidence; a running generic shell
  is not sufficient. Hibernation only applies to eligible running/waiting sessions. A verified
  Codex checkpoint preserves the conversation for resume in the same tab with a new process;
  it does not save arbitrary process memory. Without a checkpoint, the confirmation explicitly
  offers to stop without hibernating.
- There is no third-party main-process plugin execution surface. Browser privacy/profile
  controls and arbitrary website compatibility have limits documented in [known limitations](KNOWN_LIMITATIONS.md).
- Long-duration performance, broad distribution coverage, signing and publication are separate
  from the focused local AppImage validation.

See [Linux packaging](node-linux-packaging.md) for installation paths and system requirements,
and [architecture](ARCHITECTURE.md) for source ownership.

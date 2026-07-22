# Security model

This document records implemented security invariants through Milestone 6 validation. It does not
replace the [vulnerability-reporting policy](../SECURITY.md) or turn unexecuted workflow definitions
into audit evidence.

## Trust boundaries

Terminal output, terminal-provided titles and links, renderer IPC arguments, and local protocol
frames are untrusted input. The Electron main process and Rust service are privileged components;
the renderer receives only explicitly bridged capabilities. A local user able to read another
user's credential or endpoint is outside the intended boundary, so both are restricted to the
current OS user where the platform supports it.

## Renderer and Electron invariants

- The renderer runs with `contextIsolation: true`, `nodeIntegration: false`, `sandbox: true`,
  `webSecurity: true`, and insecure content disabled.
- Packaged renderer assets are served only from the path-confined
  `agent-workspace://renderer` application origin rather than privileged `file:` pages.
- The packaged renderer CSP restricts scripts and connections to its own origin. Inline styles are
  allowed because xterm.js computes terminal layout through runtime style attributes; inline
  scripts remain forbidden, and data images are the sole extra image source.
- Preload exposes a frozen typed API for specific workspace, pane, tab, terminal, settings, event,
  and external-link actions. Raw
  `ipcRenderer` and generic command execution are not exposed.
- Every IPC handler validates that the sender is the current window's main frame and validates
  structured arguments before use.
- Remote browser content runs in a dedicated `WebContentsView` with `sandbox`, context isolation,
  web security, and insecure-content blocking enabled, and with no preload, Node integration,
  desktop bridge, or generic IPC capability.
- Main verifies the exact service-owned workspace/tab/browser-session association before mounting.
  App-owned persistent partitions are validated; the renderer cannot select a raw Electron session.
- Browser permissions default-deny and require an explicit per-origin app prompt. Downloads pause
  for an app-owned save dialog, cross-origin popups are denied, same-origin popups reuse the current
  view, and non-HTTP(S) navigation requires confirmation before external opening.
- Renderer navigation is blocked. New windows are denied; only HTTPS new-window targets are passed
  to the OS, and terminal links additionally pass an HTTP/HTTPS scheme check in the IPC handler.
- The package fuse audit disables run-as-Node, Node options, CLI inspection, browser-specific V8
  snapshots, and extra `file:` privileges; it enables cookie encryption, ASAR integrity
  validation, ASAR-only loading, and WebAssembly trap handlers.

## Local control authentication

- Electron generates a random 256-bit token and transfers it to the supervised service through
  stdin, not command arguments or environment variables.
- When Electron `safeStorage` provides a secure backend, only encrypted token bytes are persisted;
  Unix credential directories and files are restricted to modes `0700` and `0600`.
- If secure encryption is unavailable, the token is session-only and is not persisted.
- The server requires authentication within five seconds, compares equal-length tokens in constant
  time, delays repeated failures, limits the process to 32 clients, and applies a 30-minute client
  idle timeout.
- Unix socket directories must be real, current-user-owned directories. They are set to `0700`, and
  the socket is created with mode `0600`.
- Windows creates the named pipe with a protected DACL granting full access only to the pipe owner
  and LocalSystem; permissive inherited, Everyone, and anonymous ACEs are excluded. The transport
  also rejects remote pipe clients. Native ACL behavior and Electron secure-storage persistence
  still require retained Windows-host validation evidence.

## Protocol and resource bounds

- Control frames are limited to 1 MiB in both directions.
- PTY output is split into decoded chunks no larger than 64 KiB.
- Checkpoint JSON is limited to 512 KiB and checkpoint sequence/dimensions are validated.
- Per-client response and event queues, the global terminal event broadcast, client subscriptions,
  startup journals, and post-checkpoint journals are bounded.
- Slow clients receive `terminal.resyncRequired` instead of causing unbounded event retention.
- Protocol validation errors use stable messages and do not include internal stack traces.
- Domain mutation replay is bounded to 256 entries and 4 MiB per client. Full frame size is checked
  before JSON parsing, and every Rust DTO has a strict Zod boundary counterpart.
- Terminal runtime-metadata discovery starts from the service-owned terminal process, includes only
  its transitive descendants, and returns at most 16 sorted, unique TCP listening ports. Process
  IDs, process names, executable paths, socket addresses, and discovery details remain inside the
  privileged service; unavailable advisory discovery degrades to an empty list.
- Service readiness is a dedicated bounded stdout record; human logs stay on stderr. Shutdown stops
  accepts, notifies authenticated clients, drains for at most two seconds, then aborts stalled
  handlers before terminating owned PTYs.

## Durable workspace state

- The SQLite database and Unix parent directory are owner-only; symbolic-link database paths are
  rejected and WAL sidecars retain restrictive permissions.
- SQLite foreign-key and schema constraints, a schema fingerprint, revision metadata, WAL mode,
  full synchronous writes, and a busy timeout are verified on open.
- Stored state is deserialized through checked domain constructors. Malformed JSON, impossible
  trees, stale revisions, same-revision divergence, and mismatched metadata fail without replacing
  the last valid state.
- Persisted terminal launch metadata contains working directory and dimensions only. Runtime IDs,
  commands, credential-bearing browser URLs, control tokens, terminal output, and checkpoints are
  excluded from workspace persistence.
- Schema-v1 databases are backed up through SQLite before schema-v2 migration. On Unix the backup
  is owner-only, migration is transactional, failure retains the backup and rolls back the source,
  and future/corrupt schemas are never silently reset.
- Healthy recovery export uses SQLite online backup so committed WAL state is included. For corrupt
  or unusable SQLite, the fallback preserves the exact raw main-file bytes as evidence; it does not
  merge or claim recovery of `-wal` or `-shm` sidecars.

## Configuration, logs, and recovery

- The schema-v2 configuration is size/depth/count bounded, validates every typed setting, migrates
  supported schema-v1 values explicitly, preserves bounded unknown fields for forward
  compatibility, rejects sensitive unknown keys, and uses owner-only atomic same-directory
  replacement on Unix.
- Durable window state accepts only bounded complete records with safe revisions, geometry,
  native-state flags, and display identifiers. Electron restores bounds only through validated
  display placement logic.
- Structured JSONL logs are record-, file-, count-, and age-bounded and owner-only on Unix.
  JSON diagnostic artifacts use an allow list, bounded log tails, recursive sensitive-key and URL/text
  redaction, and exclude databases, snapshots, notification bodies, terminal output/checkpoints,
  environment data, CLI session records, and credentials.
- Diagnostic export requires explicit user action and the exact content-free preview previously
  shown, including entry names, sizes, and redaction count. It creates a new owner-only file and
  refuses existing or linked destinations.
- Recovery startup records expose a typed category and safe bounded message. The renderer does
  not receive the internal pre-migration backup path. It receives only a safe backup-availability
  boolean; migration failure after a secured backup reports availability without disclosing the
  path.

## Terminal content protections

- OSC 52 clipboard reads and writes are denied by the renderer's clipboard provider. Normal
  user-initiated copy and optional copy-on-select use the browser clipboard API separately.
- Input containing multiple lines requires user confirmation before it is sent to the PTY.
- Web links display their target on hover and only `http:` or `https:` links may be opened
  externally through the validated bridge.
- Terminal titles are length-limited and control characters are removed before display.
- WebGL context loss or initialization failure falls back to xterm.js's canvas renderer.

## Notifications, CLI, and hooks

- Notification text, targets, history, list sizes, OSC payloads, and OSC fields are strictly
  bounded. OSC 9/777 parsing removes control characters and never alters raw PTY output.
- OS notification forwarding is opt-in for bodies; bodies are redacted by default and the setting
  is owned by the service rather than trusted renderer state.
- The public CLI accepts a session-record path but never a token flag. Unix discovery directories
  and records must be real, current-user-owned `0700`/`0600` paths and reject symlinks.
- Agent hooks are explicit, reversible, and conflict-aware. Their bounded adapters retain no raw
  payload, transcript, prompt, token, endpoint, or working-directory data.

The expanded CLI exposes named workspace list/create, terminal create/send, and pane split
operations through strict DTOs. It does not expose arbitrary protocol command selection, raw shell
execution outside typed terminal launch arguments, or browser automation.

## Updater and release supply chain

- The main process enables updates only when both stable and beta roots are present, distinct safe
  HTTPS base URLs without credentials, query, fragment, localhost, or IP-literal hosts. The
  renderer selects only the saved channel and never receives feed URLs or release notes.
- Development/unpacked/unknown packages and unsafe or incomplete feed configuration remain
  unavailable. The selected package type must match the current platform: AppImage/deb/rpm on
  Linux, DMG/zip metadata on macOS, or NSIS on Windows. AppImage installation requires its real
  runtime path.
- Checking never implies downloading, and downloading never implies installation. Each transition
  requires a separate user action; downgrades are disabled and stable/beta metadata roots remain
  separated. Errors sent to the renderer are bounded and sanitized.
- Default packages are feed-free. Opt-in metadata generation uses a real channel root and
  `--publish never`. Metadata SHA-512 and release `SHA256SUMS` provide artifact integrity but are
  not signatures and do not compensate for a compromised origin.
- Pinned workflows define clean artifact download/verification, SPDX and CycloneDX SBOMs, production
  license inventory, JavaScript/Rust advisory gates, packaged Grype scanning, and GitHub/Sigstore
  build provenance. Draft release creation is tag/version gated and never publishes automatically.
- A manually gated native workflow requires macOS Developer ID signing/notarization credentials or
  a Windows signing certificate, forces code signing, verifies the resulting signatures, and never
  publishes automatically. Current artifacts remain unsigned, no update origin or signing key is
  configured, and the workflows have not run in this repository state. Those are explicit release
  blockers rather than accepted risks for a stable release.

## Not yet claimed

There is no plugin execution or general browser-extension surface, credential sync, release
signing, hosted update service, or stable migration/support guarantee. GitHub security, package,
and provenance workflows are definitions until retained runs exist; no clean-scan claim is made
from local source inspection. Final package-host, signing-key, cross-platform, human accessibility,
and long-soak threat validation remain open; see the [roadmap](../ROADMAP.md) and
[known limitations](KNOWN_LIMITATIONS.md).

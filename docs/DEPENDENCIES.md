# Production dependency record

Production dependencies must be actively maintained, have an OSI-approved license, and serve a
documented purpose. Versions are locked in `pnpm-lock.yaml` and `Cargo.lock`; the tables below name
the direct dependencies used by the current runtime rather than duplicating lockfile
versions. Development-only tooling remains visible in the manifests and lockfiles.

## Desktop and renderer

| Dependency               | Purpose                                                                 | License |
| ------------------------ | ----------------------------------------------------------------------- | ------- |
| Electron                 | Cross-platform native window, application lifecycle, and secure storage | MIT     |
| `electron-updater` 6.8.9 | Explicit AppImage/deb/rpm stable/beta update state machine              | MIT     |
| React and React DOM      | Renderer component model                                                | MIT     |
| Zustand                  | Authoritative projection plus ephemeral presentation store              | MIT     |
| Radix UI primitives      | Accessible project-owned dialogs, menus, tabs, and controls             | MIT     |
| dnd-kit                  | Pointer and keyboard workspace/tab sorting                              | MIT     |
| react-resizable-panels   | Recursive pointer/keyboard pane resizing                                | MIT     |
| Lucide React             | Project-owned interface iconography                                     | ISC     |
| Sonner                   | Bounded non-focus-stealing in-app notification toasts                   | MIT     |
| Zod                      | Runtime validation of untrusted protocol data and IPC arguments         | MIT     |
| `@xterm/xterm`           | Terminal emulation and rendering                                        | MIT     |
| `@xterm/addon-fit`       | Fit terminal rows and columns to its pane                               | MIT     |
| `@xterm/addon-search`    | Search terminal scrollback                                              | MIT     |
| `@xterm/addon-serialize` | Serialize the renderer projection for reload checkpoints                | MIT     |
| `@xterm/addon-unicode11` | Unicode 11 cell-width data                                              | MIT     |
| `@xterm/addon-web-links` | Detect terminal URLs before validated external opening                  | MIT     |
| `@xterm/addon-clipboard` | Clipboard escape-sequence integration under the project's deny policy   | MIT     |
| `@xterm/addon-webgl`     | GPU terminal renderer with canvas fallback                              | MIT     |

Electron is declared as development/packaging input because it supplies the runtime during builds;
it is still part of the distributed desktop application. `@electron/fuses` applies and audits
production runtime fuses, while `@playwright/test` drives the Electron reload E2E. `electron-vite`,
Vite, Electron Builder, TypeScript, ESLint, Prettier, Vitest, jsdom, and Testing Library packages
are development, packaging, or test tooling rather than application runtime libraries.
Pinned `axe-core` 4.12.1 is test tooling used directly against the existing Electron renderer page;
the Playwright Electron context cannot create the extra browser page expected by the optional
wrapper. No axe rules are suppressed.

## Rust service

| Dependency                     | Purpose                                                              | License                               |
| ------------------------------ | -------------------------------------------------------------------- | ------------------------------------- |
| Tokio                          | Asynchronous runtime, process coordination, and I/O                  | MIT                                   |
| `portable-pty`                 | Cross-platform PTY creation, I/O handles, resize, and child control  | MIT                                   |
| `listeners` 0.6.0              | Cross-platform native TCP socket ownership and listening-state scan  | MIT                                   |
| `sysinfo` 0.39.6               | Cross-platform terminal root/descendant process-tree snapshots       | MIT                                   |
| `interprocess`                 | Unix-socket and Windows named-pipe abstraction                       | 0BSD OR Apache-2.0                    |
| `widestring`                   | Compile-time Windows SDDL passed to the safe named-pipe ACL wrapper  | MIT OR Apache-2.0                     |
| Serde and `serde_json`         | NDJSON and protocol DTO serialization                                | MIT OR Apache-2.0                     |
| `ts-rs`                        | Generate TypeScript DTOs from Rust wire types                        | MIT                                   |
| `base64`                       | Encode raw PTY input and output in JSON-safe wire fields             | MIT OR Apache-2.0                     |
| UUID                           | Generate terminal identifiers                                        | MIT OR Apache-2.0                     |
| `uzers`                        | Resolve the current Unix user's account database entry and shell     | MIT                                   |
| `which`                        | Resolve PowerShell and command-shell executables on Windows          | MIT                                   |
| Rustix                         | Unix user identity, permissions, signals, and low-level process data | Apache-2.0 WITH LLVM-exception OR MIT |
| `subtle`                       | Constant-time local control-token comparison                         | BSD-3-Clause                          |
| `thiserror`                    | Typed Rust library errors                                            | MIT OR Apache-2.0                     |
| Tracing and tracing-subscriber | Structured service diagnostics and bounded JSONL integration         | MIT                                   |
| Clap                           | Rust service command-line parsing                                    | MIT OR Apache-2.0                     |
| `rusqlite`                     | Bundled SQLite persistence and transactional revision checks         | MIT                                   |
| `url`                          | Remove credentials, query, and fragments from diagnostic URLs        | MIT OR Apache-2.0                     |

`tempfile` is a Rust test dependency. Workspace dependencies listed in the root `Cargo.toml` but
not consumed by a runtime crate are not represented as shipped functionality.

## Addition policy

Electron Builder is distribution tooling rather than application runtime code. Any new direct
production dependency requires an update to this record in the same pull request, including its
role, license, and the architectural boundary that owns it. The implementation specification's
larger inventory describes planned scope; it is not evidence that every listed package is already
installed.

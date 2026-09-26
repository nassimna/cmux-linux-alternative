# Production dependency record

The current Linux application uses the pinned versions in `pnpm-lock.yaml`. There is no Cargo workspace or Rust runtime dependency. Electron supplies the desktop runtime; a pinned Node executable and native addons are bundled with Linux candidates. Exact shipped files are checked by the [Node package inspector](node-linux-packaging.md).

| Package                                                              | Purpose                                                             | Location                                                        |
| -------------------------------------------------------------------- | ------------------------------------------------------------------- | --------------------------------------------------------------- |
| Electron, `electron-updater`                                         | Native windows, browser views, OS integration, and explicit updates | `apps/desktop`                                                  |
| React, React DOM, Zustand, Radix UI, dnd-kit, react-resizable-panels | Workspace presentation and interaction                              | `apps/web`                                                      |
| xterm.js and addons                                                  | Terminal display, fitting, search, and checkpoints                  | `apps/web`                                                      |
| Hono, `@hono/node-server`                                            | Authenticated local HTTP boundary                                   | `apps/server`                                                   |
| `better-sqlite3`                                                     | Durable local state and revisioned mutations                        | `apps/server`                                                   |
| `node-pty`                                                           | Local terminal processes and resize                                 | `apps/server`                                                   |
| `ssh2`                                                               | Remote SSH/tmux transport                                           | `apps/server`                                                   |
| `dbus-next`                                                          | Linux Secret Service integration                                    | `apps/server`                                                   |
| `@noble/ciphers`, `@noble/hashes`                                    | Encrypted content and key handling                                  | `apps/server`                                                   |
| `ws`                                                                 | Bounded local event transport                                       | `apps/server`                                                   |
| Zod                                                                  | Validation at contract, IPC, and service boundaries                 | `packages/contracts`, `packages/protocol-client`, `apps/server` |

The manifests are authoritative for exact direct dependencies. Build and test tools, including TypeScript, esbuild, Vite, Vitest, Playwright, ESLint, Prettier, and Electron Builder, are declared separately. New production dependencies require a documented purpose, license review, locked version, native-package compatibility check where applicable, and updated SBOM and vulnerability evidence before release.

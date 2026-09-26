# Node service

The Linux desktop backend runs in a separate Node.js process. Hono handles the authenticated
HTTP boundary; plain TypeScript services own domain behavior. Electron launches and supervises
the service with a private token and an ephemeral loopback port.

## Responsibilities

- SQLite workspace state, groups, panes, tabs, window ownership, layouts, and focus history.
- Local PTYs, terminal output streams, shell configuration, and restart/checkpoint behavior.
- Agent catalogs, restore/fork, conditional hibernation, teams, and attention.
- SSH target credentials through Secret Service, exact host-key trust, and remote tmux sessions.
- Files, editable documents, Markdown/diffs, consent-based encrypted Vault/search, and tasks.
- Notifications, settings, actions, diagnostics, and recovery exports.

`src/http` validates requests and maps errors. `src/domain`, `src/agents`, `src/remote`, and
`src/content` implement the service behavior. `src/persistence` owns database transitions and
revision/idempotency checks. Shared request/response contracts live in `packages/contracts` and
`packages/protocol-client`; `packages/client-runtime` supplies the desktop and CLI transport.

## Development

Run the complete application from the repository root:

```sh
pnpm dev
```

Build only the server with `pnpm --filter @agent-workspace/server build`. The server entry point
requires an authenticated, explicitly configured state owner; starting it without those settings
is intentionally rejected. Use the desktop launch path for normal development.

## State and migration

Native Linux profiles use `state/workspace.sqlite` under Electron's user-data directory. The
service creates fresh profiles and locks existing profiles before writing. The first open of a
legacy profile creates `pre-node-migration.sqlite`, preserves qualified desktop settings, and
validates trusted SSH host records. Original settings and the database backup remain available.

The isolated-copy and fenced handoff helpers are retained for migration diagnostics and fixture
validation. They are not required for normal startup. See [architecture](../../docs/ARCHITECTURE.md),
[Linux packaging](../../docs/node-linux-packaging.md), and [migration ADR](../../docs/decisions/0014-node-service-migration.md).

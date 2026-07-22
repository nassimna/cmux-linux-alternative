# cmux clean-room evidence log

## Scope and rules

This log records user-observable behavior used by
[`CMUX_PARITY_IMPLEMENTATION_SPEC.md`](CMUX_PARITY_IMPLEMENTATION_SPEC.md). The pinned upstream
baseline is `manaflow-ai/cmux` commit
[`6849b9351c4a776680ffef34a0323c15e88ea0e7`](https://github.com/manaflow-ai/cmux/tree/6849b9351c4a776680ffef34a0323c15e88ea0e7),
dated 2026-07-18. Official documentation and changelog entries are considered only through release
`0.64.19` (2026-07-14).

The inventory records outcomes, interaction models, and public command shapes. It does not copy
upstream source, assets, product identity, icons, wording, or trade dress. Local implementation
choices must follow this repository's own ownership, security, protocol, persistence, and UI
patterns. A later upstream change cannot silently expand scope; it requires a dated delta audit.

## Evidence register

Every observation below was recorded on 2026-07-20. The link targets the immutable pinned commit;
the blob SHA is the Git object identity returned by the pinned tree. Live official pages may remain
useful for readers, but they are not the reproducibility anchor.

| ID     | Immutable source and blob SHA                                                                                                                                                                                                     | Observed outcomes                                                                                                                                       | Inventory rows                                               |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------ |
| UP-001 | [Pinned README](https://github.com/manaflow-ai/cmux/blob/6849b9351c4a776680ffef34a0323c15e88ea0e7/README.md), `8065e5f5d0cce0ed54cc3a4cd455d345e94b0bb7`                                                                          | Workspaces, panes, terminal/browser surfaces, notification rings/panel, metadata, SSH, teams, automation, shortcuts, and bounded restore claims.        | Workspace/card, window/action/browser, restore/agents/remote |
| UP-002 | [Pinned concepts page](<https://github.com/manaflow-ai/cmux/blob/6849b9351c4a776680ffef34a0323c15e88ea0e7/web/app/%5Blocale%5D/(landing)/docs/concepts/page.tsx>), `3d28ea58c83b11d7e81b063b4fee08f9221fbcb5`                     | Workspace, group, pane, surface, terminal, and browser concepts and visible nesting.                                                                    | Workspace/card/navigation                                    |
| UP-003 | [Pinned workspace-groups page](<https://github.com/manaflow-ai/cmux/blob/6849b9351c4a776680ffef34a0323c15e88ea0e7/web/app/%5Blocale%5D/(landing)/docs/workspace-groups/page.tsx>), `86fe9263392dda6251e77b00510f9428a4774647`     | Collapsible groups, anchors, pinning, ordering, multiselect, keyboard paths, persistence, and CLI.                                                      | Pinning, multiselect, groups                                 |
| UP-004 | [Pinned browser-automation page](<https://github.com/manaflow-ai/cmux/blob/6849b9351c4a776680ffef34a0323c15e88ea0e7/web/app/%5Blocale%5D/(landing)/docs/browser-automation/page.tsx>), `fc3852a363c15302d78feee97a0d42a97cdb4fba` | Addressable browser navigation, waits, DOM input, inspection, screenshot, state, frames, dialogs, downloads, and logs.                                  | Browser and automation                                       |
| UP-005 | [Pinned SSH page](<https://github.com/manaflow-ai/cmux/blob/6849b9351c4a776680ffef34a0323c15e88ea0e7/web/app/%5Blocale%5D/(landing)/docs/ssh/page.tsx>), `080c2496d39095981036e5ce29bb4beeb1dd795e`                               | SSH workspaces, confirmation, remote browser routing, reconnect state, notifications, and relay behavior.                                               | SSH/remote                                                   |
| UP-006 | [Pinned remote-tmux page](<https://github.com/manaflow-ai/cmux/blob/6849b9351c4a776680ffef34a0323c15e88ea0e7/web/app/%5Blocale%5D/(landing)/docs/remote-tmux/page.tsx>), `efee26fac29ec929eaa6c7ce1964b50eb1b1d3dd`               | Opt-in discovery/attach, mirrored panes/windows, detach/reconnect, identity, version checks, and remote ownership.                                      | Remote tmux                                                  |
| UP-007 | [Pinned keyboard-shortcuts page](<https://github.com/manaflow-ai/cmux/blob/6849b9351c4a776680ffef34a0323c15e88ea0e7/web/app/%5Blocale%5D/(landing)/docs/keyboard-shortcuts/page.tsx>), `3c310f81b98dc9683a76f619867f0157c54cde62` | Workspace, surface, pane, browser, notification, find, sidebar, window, and terminal keyboard paths.                                                    | Baseline desktop controls; advanced navigation               |
| UP-008 | [Pinned configuration page](<https://github.com/manaflow-ai/cmux/blob/6849b9351c4a776680ffef34a0323c15e88ea0e7/web/app/%5Blocale%5D/(landing)/docs/configuration/page.tsx>), `13c472071a47b6f060f73c8c31d69bc862c9fdf7`           | Typed app settings, shortcuts, sidebar modes, browser preferences, and project behavior.                                                                | Configuration and customization                              |
| UP-009 | [Pinned custom-commands page](<https://github.com/manaflow-ai/cmux/blob/6849b9351c4a776680ffef34a0323c15e88ea0e7/web/app/%5Blocale%5D/(landing)/docs/custom-commands/page.tsx>), `ee6f607934b95346e9cbade692cb9e82e9bbb9ee`       | Project declarative actions, builtin aliases, palette discovery, and explicit executable/arguments.                                                     | Actions/custom commands                                      |
| UP-010 | [Pinned session-restore page](<https://github.com/manaflow-ai/cmux/blob/6849b9351c4a776680ffef34a0323c15e88ea0e7/web/app/%5Blocale%5D/(landing)/docs/session-restore/page.tsx>), `90b6e6ee716443a18086b52e256c99d7ed26a836`       | Versioned layout, best-effort scrollback, browser history, supported resume, explicit trust, and no process-memory clone promise.                       | Restore and agents                                           |
| UP-011 | [Pinned changelog page](<https://github.com/manaflow-ai/cmux/blob/6849b9351c4a776680ffef34a0323c15e88ea0e7/web/app/%5Blocale%5D/(landing)/docs/changelog/page.tsx>), `818942e121fe0f8d3e310db5855b370991b04d30`                   | Pinning, metadata, palette, groups, recently closed, hibernation, detachable SSH, layouts, sidebar, and agent orchestration through the audit boundary. | All dated feature rows                                       |
| UP-012 | [Pinned Vault page](<https://github.com/manaflow-ai/cmux/blob/6849b9351c4a776680ffef34a0323c15e88ea0e7/web/app/%5Blocale%5D/(landing)/docs/vault/page.tsx>), `286478eeec028a156d62739f290331ff55adb20c`                           | Transcript indexing/search across supported agent formats in a sidebar surface.                                                                         | Vault and transcript search                                  |

## Local evidence register

| ID      | Source                                                                                                                         | What it proves                                                                                                 |
| ------- | ------------------------------------------------------------------------------------------------------------------------------ | -------------------------------------------------------------------------------------------------------------- |
| LOC-001 | [`ARCHITECTURE.md`](ARCHITECTURE.md)                                                                                           | Current process, trust, runtime, browser, persistence, and projection ownership.                               |
| LOC-002 | [`PROTOCOL.md`](PROTOCOL.md)                                                                                                   | Implemented authenticated commands, events, capabilities, bounds, and compatibility behavior.                  |
| LOC-003 | [`IMPLEMENTATION_MILESTONE_AUDIT.md`](IMPLEMENTATION_MILESTONE_AUDIT.md)                                                       | Pre-parity implementation baseline and retained local validation boundary.                                     |
| LOC-004 | [`SECURITY_MODEL.md`](SECURITY_MODEL.md)                                                                                       | Current renderer, preload, IPC, local control, browser, storage, diagnostics, and content security invariants. |
| LOC-005 | [`decisions/0001-process-and-protocol-boundaries.md`](decisions/0001-process-and-protocol-boundaries.md)                       | Accepted authoritative process and protocol ownership.                                                         |
| LOC-006 | [`decisions/0002-ephemeral-workspace-card-slots.md`](decisions/0002-ephemeral-workspace-card-slots.md)                         | Accepted fixed status/progress sidecar ownership and invalidation model.                                       |
| LOC-007 | [`validation/2026-07-20-m1-cards-attention.md`](validation/2026-07-20-m1-cards-attention.md)                                   | Qualified bounded rich-card, density, attention, interaction, a11y, visual, and starvation behavior.           |
| LOC-008 | [`decisions/0006-durable-workspace-organization-and-layouts.md`](decisions/0006-durable-workspace-organization-and-layouts.md) | Accepted durable organization, limit, portable-layout, and atomic-apply ownership.                             |
| LOC-009 | [`validation/2026-07-20-m2-organization-layouts.md`](validation/2026-07-20-m2-organization-layouts.md)                         | Qualified multiselect, groups, pinning, migrations, layouts, lifecycle cleanup, a11y, and packaged flows.      |

## Audit history

| Date       | Auditor                    | Change                                                                                                                             |
| ---------- | -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| 2026-07-19 | Repository parity audit    | Pinned the upstream commit and public-documentation release boundary; created the executable parity specification.                 |
| 2026-07-20 | Local implementation audit | Added the clean-room evidence register, capability inventory, contract matrix, decision records, and milestone work decomposition. |
| 2026-07-20 | M1/M2 qualification audit  | Qualified cards/attention and durable organization/layouts; updated only the corresponding local inventory rows.                   |

## Change control

New evidence must record its URL or immutable revision, observation date, affected inventory rows,
and whether it changes Tier A scope. Implementation details learned from upstream source must not be
transcribed. Ambiguous behavior remains `Unknown` or `Missing`; absence of evidence is never a local
pass.

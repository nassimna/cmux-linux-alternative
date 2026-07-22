# Configuration

Settings are stored in the versioned, human-readable
`configuration/desktop.json` beneath Electron's Linux `userData` directory. The Rust service owns
validation, optimistic revisions, and atomic persistence. Prefer the Settings UI; stop the app
before hand-editing, keep `schemaVersion: 2`, and make a backup first. Valid schema-v1 files are
migrated by the current service, but new manual edits should use the current schema.

## Implemented settings

| Section            | Defaults                                                                                     | Behavior today                                                                                                                                                                                                                                                                                                                                                                 |
| ------------------ | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Appearance         | theme `system`; density `comfortable`                                                        | Persisted and applied live. Theme is `system`, `dark`, or `light`; density is `comfortable`, `compact`, or schema-v2 `expanded`. Schema-v1 compact/comfortable files migrate to v2; expanded UI is gated by `configuration-v2`.                                                                                                                                                |
| Terminal           | shell `null`; family `monospace`; size `13`; scrollback `10000`; multiline protection `true` | Family, size, scrollback, and multiline-paste protection persist and apply live. Font size is 6–72; scrollback is 100–1,000,000. An empty shell uses the system default. A configured shell must be an absolute executable file on the current host; it applies to new and restarted implicit terminals, while existing PTYs and explicit workspace commands remain unchanged. |
| Browser            | profile `Default`; partition `default`; privacy `standard`                                   | Persisted, but controls are disabled and do not reconfigure current browser sessions. Privacy accepts `standard` or `strict`.                                                                                                                                                                                                                                                  |
| Notifications      | system notifications `true`; include body `false`                                            | Persisted and applied live. Bodies remain excluded by default.                                                                                                                                                                                                                                                                                                                 |
| Keyboard shortcuts | empty override map                                                                           | Persisted and dispatched live. A string overrides a command; `null` clears its shortcut. See [Shortcuts](SHORTCUTS.md).                                                                                                                                                                                                                                                        |
| Agent integration  | enabled/notifications/browser all `true`                                                     | Persisted schema fields, but the settings controls have no runtime owner. Hook installation is a separate explicit CLI action.                                                                                                                                                                                                                                                 |
| Updates            | channel `stable`                                                                             | Persisted and applied to the updater. `stable` and `beta` select only preconfigured trusted roots; the renderer cannot set a URL.                                                                                                                                                                                                                                              |
| Logging            | level `info`                                                                                 | Persisted and applied immediately to subsequent service log events. Values are `error`, `warn`, `info`, `debug`, and `trace`. A valid startup `RUST_LOG` filter takes initial precedence until the level is explicitly changed through configuration.                                                                                                                          |

Terminal copy-on-select and per-terminal screen-reader mode are renderer-local controls and are not
persisted. Screen-reader mode resets when the terminal pane remounts.

Unknown non-sensitive fields are retained within strict size/depth/count bounds for forward
compatibility. Invalid known values, future schema versions, oversized files, unsafe paths, and
sensitive unknown keys are rejected rather than silently normalized.

## Update environment

Runtime updates remain disabled unless both variables are supplied to the packaged desktop:

```text
AGENT_WORKSPACE_UPDATE_STABLE_URL
AGENT_WORKSPACE_UPDATE_BETA_URL
```

They must be distinct HTTPS base URLs with no credentials, query, fragment, localhost name, or IP
literal. Changing the saved channel never changes these trust roots. Build-time update metadata is
opt-in through `AGENT_WORKSPACE_UPDATE_BUILD_URL` and
`AGENT_WORKSPACE_UPDATE_BUILD_CHANNEL`; normal `pnpm package:linux` output is feed-free. See
[Desktop updates](UPDATES.md).

## Development-only environment

`AGENT_WORKSPACE_SOCKET` and `AGENT_WORKSPACE_SERVICE_PATH` override development wiring and are
ignored for selecting packaged trust roots. `AGENT_WORKSPACE_SESSION_FILE` selects a CLI discovery
record path, never a raw token. These variables are operational interfaces, not persisted user
settings.

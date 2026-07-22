# Keyboard shortcuts

`Primary` maps to `Ctrl` on Linux and Windows and to `Command` on macOS. `Secondary` maps to `Alt`
on Linux/Windows and `Option` on macOS. The Electron E2E suite uses the same native mapping on each
platform; only Linux has retained execution evidence today.

| Command                    | Default on Linux |
| -------------------------- | ---------------- |
| New workspace              | `Ctrl+N`         |
| New terminal               | `Ctrl+T`         |
| Close active tab           | `Ctrl+W`         |
| Split right                | `Ctrl+D`         |
| Split down                 | `Ctrl+Shift+D`   |
| Toggle sidebar             | `Ctrl+B`         |
| Command palette            | `Ctrl+Shift+P`   |
| Search active terminal     | `Ctrl+F`         |
| Open browser split         | `Ctrl+Shift+L`   |
| Notification center        | `Ctrl+I`         |
| Latest unread notification | `Ctrl+Shift+U`   |
| Settings                   | `Ctrl+,`         |

Browser Back, Forward, Reload, Stop, and Developer Tools are palette commands without default
shortcuts.

## Customize and resolve conflicts

Open Settings, edit a shortcut, then save that command. Portable strings use logical
modifiers such as `Primary+Shift+P`; clearing a command stores `null` and disables its default.
Reset restores the built-in mapping. Supported keys include letters, digits, F1–F24, navigation
and editing keys, Space, and common punctuation.

The editor detects physical conflicts for the current platform. A conflicting mapping is not a
reliable way to choose between commands: assign a unique combination or clear one. On Linux,
`Primary` and explicit `Control` both map to physical Ctrl and can therefore conflict.

## Focus behavior

Matched shortcuts prevent the underlying terminal or browser from receiving the key. Repeated
keydown events are consumed for non-repeatable commands, while IME composition is left untouched.
Commands can be unavailable when their required context is missing—for example terminal search
without an active terminal or browser navigation without an active browser/history entry.

Composite controls use their own keyboard navigation: workspace and tab lists support arrow/Home
navigation, dialogs trap and restore focus, and pane separators are keyboard adjustable. Terminal
applications still receive unmatched keys normally.

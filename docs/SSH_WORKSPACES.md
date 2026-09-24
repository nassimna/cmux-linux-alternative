# SSH workspaces

Choose **SSH workspace** in the sidebar. Enter a host or `~/.ssh/config` alias, an optional
username, and a port. The app creates a workspace, starts `ssh` in its first terminal, and pins
the workspace. Select the pinned workspace to return to its existing tabs, including after an app
restart. **New shell** starts a separate OpenSSH process; it does not resume a remote process.
For a durable remote tmux session with managed reconnect state, use **Settings → Remote sessions**.

The saved workspace contains only host, username, and port in Electron's local renderer storage.
Keys, passwords, host trust, proxy rules, and other SSH settings remain with OpenSSH. The SSH
connection still uses normal host verification and authentication. Saved connection details are
local to this app profile and are not included in service snapshots or layout exports.

Any workspace can be pinned or unpinned with the pin button on its card or its context menu.
Pinning and workspace order are stored by the service. The SSH workspace context menu can edit
connection details for future shells or forget the saved details without closing existing tabs.
Closing a workspace keeps its connection details locally so they can be reused or removed under
**Previously saved connections** in the SSH workspace dialog. Removing them does not alter
OpenSSH's configuration, keys, or known hosts.

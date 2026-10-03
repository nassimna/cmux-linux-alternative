# Known limitations

The current application uses Electron, React, and a Node/Hono backend. Linux x86_64 is the
current packaging and validation target. Older milestone, accessibility, and performance records
in this repository describe their recorded builds; they are not evidence for the current Node
AppImage.

- The application is pre-1.0. Local installation does not constitute a signed, published stable
  release. Public release automation, update feeds, signing, and broader Linux distribution
  coverage have not been qualified for this candidate.
- macOS, Windows, and ARM64 are not qualified by the Linux Node migration.
- Managed SSH credentials require a working Secret Service wallet and an unencrypted Ed25519
  OpenSSH key at enrollment. Host trust is explicit. Managed remote sessions require tmux 3.2+
  on the remote host. Remote browser routing and notification relay are not implemented.
- Durable agent restore, fork, and hibernation depend on the supported Codex adapter/version and
  an authenticated provider profile. Claude can run in terminals and use notification hooks;
  that does not imply the same durable session lifecycle support as Codex.
- Saved layouts currently require a single hosted window. Layout application creates fresh
  runtimes; it does not serialize arbitrary running processes.
- Browser profile/privacy settings and arbitrary website compatibility are not fully qualified.
  There is no third-party main-process plugin execution surface.
- Encrypted search requires an unlocked Secret Service wallet and explicit indexing consent.
  Source access and indexing policies remain separate from workspace membership.
- Fresh profiles and existing schema-v15 profiles have distinct startup paths. Existing profiles
  retain a pre-Node database backup and original settings. Unknown or inconsistent state fails
  into recovery rather than being discarded.
- Long-duration Node performance/soak testing and manual assistive-technology qualification are
  outside the focused migration validation pass. Earlier Rust-package measurements must not be
  presented as measurements of the Node app.

See [architecture](ARCHITECTURE.md), [Linux packaging](node-linux-packaging.md),
[updates](UPDATES.md), and [release qualification](RELEASE_QUALIFICATION.md).

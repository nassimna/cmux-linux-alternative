# Desktop updates

The desktop uses `electron-updater` for AppImage, deb, rpm, macOS DMG/zip, and Windows NSIS
packages. The titlebar's **Updates** button opens update settings directly. Manual checks,
downloads, and **Restart to update** remain available when automatic updates are disabled.
Automatic checks and background downloads are opt-in; installation always requires an explicit
restart. Linux update installation and native signing have not been qualified end to end.

## Feed configuration

Packaged applications default to the public `nassimna/cmux-linux-alternative` GitHub Releases
provider. Stable uses the updater's `latest` channel. Beta and Alpha use their matching channels and permit
prereleases; choose **Alpha** in Settings to receive this release series.
Normal package builds generate updater metadata without uploading it. The release workflow
collects each platform’s manifests and blockmaps alongside the installable packages. macOS
metadata includes both Intel and Apple Silicon artifacts. Existing releases
without this metadata cannot serve an in-app update.

Release versions must match the root and desktop package manifests before packaging. Unsigned
alpha releases use `-alpha.N` and are published as prereleases. The Beta channel excludes Alpha
tags; the Stable channel excludes all prereleases. GitHub Actions must be enabled to run the release workflow.

To override GitHub with generic HTTPS hosting, supply both trusted feed roots in the
packaged application's runtime environment:

- `AGENT_WORKSPACE_UPDATE_STABLE_URL`
- `AGENT_WORKSPACE_UPDATE_BETA_URL`
- `AGENT_WORKSPACE_UPDATE_ALPHA_URL` (optional; required to select Alpha with generic hosting)

The values must be different HTTPS base URLs without credentials, query strings,
fragments, localhost names, or IP-literal hosts. They are read only by the main
process. The renderer selects `stable`, `beta` or `alpha`; it cannot provide a URL or
provider configuration.

For generic hosting, package generation requires a channel-specific URL and channel. Use the
platform's explicit update script to replace the default GitHub provider, and use `alpha` with
the alpha root for an alpha build:

```sh
AGENT_WORKSPACE_UPDATE_BUILD_URL=https://<trusted-host>/desktop/alpha/ \
AGENT_WORKSPACE_UPDATE_BUILD_CHANNEL=alpha \
pnpm --filter @agent-workspace/desktop package:linux:updates
```

On a matching native host, replace the final command with `package:mac:updates` or
`package:windows:updates`. Stable macOS candidates must be Developer ID signed and notarized;
stable Windows candidates must be signed. The manually gated `Signed native release candidates`
workflow enforces signing and verifies the result, but it has not been executed in this repository
state.

`--publish never` is intentional:
the build emits update metadata but never uploads it. The build URL must be the
same root supplied for that runtime channel. Do not reuse a directory between
channels.

Each directory is self-contained, for example:

```text
stable/
  stable-linux.yml
  stable-mac.yml
  stable.yml
  agent-workspace-<version>-x86_64.AppImage
  agent-workspace-<version>-x86_64.deb
  agent-workspace-<version>-x86_64.rpm
  agent-workspace-<version>-macos-x64.dmg
  agent-workspace-<version>-macos-x64.zip
  agent-workspace-<version>-windows-x64-setup.exe
alpha/
  alpha-linux.yml
  alpha-mac.yml
  alpha.yml
  agent-workspace-<version>-x86_64.AppImage
  agent-workspace-<version>-x86_64.deb
  agent-workspace-<version>-x86_64.rpm
```

Keep the metadata and every referenced artifact together. Electron Builder puts
SHA-512 hashes in the metadata; `electron-updater` verifies those hashes before
an install. HTTPS hosting and strict separation prevent a renderer or one channel
setting from selecting the other channel's root. Hashes do not replace release
signing or secure control of the hosting origin.

## Runtime behavior

The saved `updates.automatic` preference defaults to `false`, including for existing profiles.
Enable **Automatically check and download updates** and save the section to check immediately
and every six hours, and download available updates in the background. Disabling it stops
automatic checks; an existing download remains available. Manual checking and downloading still
work. The titlebar shows **Update available** or **Update ready** when appropriate.

Installation requires **Restart to update**. Window state is flushed before the normal shutdown
path stops the Node service. Local terminals and running agents may be interrupted; saved
workspace state does not preserve arbitrary running processes. Release notes and feed URLs are
not sent to the renderer, and updater errors are reduced to bounded messages.

An AppImage must be launched through its normal AppImage runtime so `APPIMAGE` identifies the
installed file. Deb and rpm builds use Electron Builder's `resources/package-type` marker and may
prompt through the host package manager during installation. macOS uses the updater-compatible
DMG/zip pair, and Windows uses NSIS. Development builds, unpacked directories, platform/package
mismatches, unknown package types, and installations with invalid override feeds report an
unavailable state instead of attempting network access.

## Manual feed test

Build an older and a newer package with the same channel-specific build root.
Place the newer artifacts and generated metadata in that root on an HTTPS test
server, then launch the installed older package with both runtime feed variables.
Verify check, explicit download, hash rejection after deliberately modifying an
artifact, and explicit install/restart. Use a valid local TLS certificate; plain
HTTP and localhost are rejected in production. Deb/rpm tests should run in a
disposable VM with the appropriate package manager. AppImage tests must launch the actual AppImage
rather than an unpacked directory. macOS and Windows tests must verify platform signatures before
qualifying an update and must exercise an installed DMG/NSIS candidate, not only an unpacked
application.

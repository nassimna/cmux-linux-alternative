# Desktop updates

The desktop uses `electron-updater` for explicit, user-approved updates of AppImage, deb, rpm,
macOS DMG/zip, and Windows NSIS packages. There is no hosted update feed, signing key, or published
desktop release configured in this repository today.

## Feed configuration

Both trusted feed roots must be present in the packaged application's runtime
environment or updates remain disabled:

- `AGENT_WORKSPACE_UPDATE_STABLE_URL`
- `AGENT_WORKSPACE_UPDATE_BETA_URL`

The values must be different HTTPS base URLs without credentials, query strings,
fragments, localhost names, or IP-literal hosts. They are read only by the main
process. The renderer selects `stable` or `beta`; it cannot provide a URL or
provider configuration.

Package generation with update metadata requires a channel-specific generic-provider URL and
channel. Use the platform's explicit update script rather than its feed-free default package
script, and use `beta` with the beta root for a beta build:

```sh
AGENT_WORKSPACE_UPDATE_BUILD_URL=https://<trusted-host>/desktop/stable/ \
AGENT_WORKSPACE_UPDATE_BUILD_CHANNEL=stable \
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
beta/
  beta-linux.yml
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

The application periodically checks the selected channel and also offers a
manual check. It never downloads an update merely because one was found. The
user must separately approve download and then installation/restart. Release
notes and feed URLs are not sent to the renderer, and updater errors are reduced
to bounded messages.

An AppImage must be launched through its normal AppImage runtime so `APPIMAGE` identifies the
installed file. Deb and rpm builds use Electron Builder's `resources/package-type` marker and may
prompt through the host package manager during installation. macOS uses the updater-compatible
DMG/zip pair, and Windows uses NSIS. Development builds, unpacked directories, platform/package
mismatches, unknown package types, and installations without both trusted feeds report an
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

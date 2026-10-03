# Releasing Ternline

The **Release** workflow builds Linux x64, macOS Intel x64, macOS Apple Silicon arm64, and
Windows x64 on matching native GitHub runners. It publishes only when all four packaged-runtime
smoke checks pass. The **Deploy website** workflow follows a successful published release and
builds the Signal website with matching, versioned download URLs.

## Prepare and qualify

1. Set the same semantic version in the root and desktop manifests, including the desktop
   checksum and verification scripts. Use an `-alpha.N` suffix for unsigned prereleases. Every new
   version must be greater than every published version and retained release tag: advance
   `alpha.N` or the base version. GitHub includes tags without releases in its Atom feed; a retained
   higher beta tag can hide an alpha release and cause missing-metadata errors. When returning to
   alpha, advance the base version (for example, `0.2.0-beta.1` → `0.2.1-alpha.1`).
2. Add a non-empty versioned section to `CHANGELOG.md` and keep `[Unreleased]` for future work.
3. Run affected tests and `pnpm release:validate --version x.y.z --mode candidate --tag vx.y.z`.
4. Dispatch **Release** from the PR branch with `version: VERSION` and `publish: false` to build
   and test every platform before merging. Inspect its logs and retained smoke evidence.
5. Merge the qualified source, create the annotated `vVERSION` tag on that commit, and push it.
   A tag run publishes the prerelease after every platform succeeds. A manual publication also
   requires the workflow ref to be that exact tag.

Builds use the frozen lockfile, cached pnpm downloads, pinned actions, and Node 22.23.3.
Release concurrency prevents overlapping runs for the same ref. PR CI runs Node validation and
focused Windows runtime contracts on Windows 2022;
expensive distro-package and security inventories remain scheduled or manual.

## Artifacts and checksums

Each native build first launches the packaged app with a new, isolated user-data directory,
waits for the authenticated Node service, and exercises the packaged CLI and a real PTY. Windows
checks the installed NSIS package. All platforms exercise browser automation and workspace
persistence across restart. Linux also inspects AppImage/deb/rpm contents and hashes.
Fresh profiles default to the release's channel (Alpha, Beta, or Stable), with automatic updates
off until the user opts in. Saved channel and automatic-update preferences survive upgrades.
Native smoke checks verify the Alpha default and that automatic-update settings persist on restart.

Windows private writers set their own process token's default object owner to the current user,
so SQLite-created journals, WAL and SHM files retain the same owner-only proof as explicitly
created state files. Existing paths with unsafe permissions, reparse points or hard links are
rejected. Native tests cover these files, lock release on process death, private child IPC, and
Windows terminal path restoration without allowing traversal outside the workspace.

The release contains:

- Linux x64 AppImage, deb, and rpm.
- macOS arm64 and x64 DMG/zip pairs.
- Windows x64 NSIS EXE.
- Platform alpha updater manifests and their blockmaps.
- Deterministic `SHA256SUMS` and a `release-manifest.json` identifying the version and source commit.

Publication rejects colliding artifact names and verifies every expected installer is present.
The macOS updater manifest combines both architectures and retains their individual hashes.
Do not replace a published release's assets in place; ship a new version for corrections.

## In-app updates

Open **Settings → Updates**, select the channel, enable **Automatically check and download
updates**, and save the section. The app checks immediately, checks again on each launch, and
checks every six hours while running. Downloads happen in the background; **Restart to update**
applies the update only when the user chooses. Automatic updates never restart an active workspace.

Alpha follows alpha, beta, and stable releases; Beta follows beta and stable; Stable follows stable.
The updater reads platform metadata from GitHub Releases and rejects equal or lower versions.
Existing installations must select Alpha if their saved channel is Beta or Stable. An alpha
release on a higher base version can update an earlier beta without allowing downgrades. Deleting
old GitHub releases does not change installed preferences or remove their tags.
Unsigned macOS builds require manual installation;
[macOS auto-installation requires signing](https://www.electron.build/docs/features/auto-update/).

## Signing and qualification limits

These are unsigned prereleases: signing secrets are not configured. The native build disables
macOS signing/notarization explicitly. Windows installers have no Authenticode signature.
Checksums are integrity evidence and do not replace code signing or trusted delivery. A stable
release requires maintainer-owned signing and notarization credentials and their verification.

Hosted startup and CLI/PTY checks do not prove physical-device GPU behavior, desktop notifications,
installer trust UX, accessibility with assistive technology, an eight-hour soak, or complete
in-app update installation. Linux ARM64 and Windows ARM64 are outside this release scope.

The manual **Release candidate** workflow retains direct accessibility, visual, recovery, distro,
and security qualification. Complete the [release qualification record](RELEASE_QUALIFICATION.md)
with retained evidence; leave unrun checks as `NOT RUN` and do not claim stable qualification.

## Clean-host matrix and limitations

The exact uploaded bundle is downloaded and checksum-verified before every install:

| Environment                     | Qualification                                                                   |
| ------------------------------- | ------------------------------------------------------------------------------- |
| Ubuntu 24.04 container          | inspect deb contents, install dependencies/package, launch installed executable |
| Fedora 42 container             | inspect rpm contents, install dependencies/package, launch installed executable |
| Ubuntu 24.04 container          | extract AppImage without FUSE, inspect bundled Node runtime, launch `AppRun`    |
| Ubuntu 24.04 software-rendering | launch the same extracted AppImage with Electron `--disable-gpu`                |
| Ubuntu 24.04 headless Wayland   | launch the same AppImage against a private Weston/pixman Wayland socket         |
| Arch Linux container            | extract the same AppImage, inspect Node runtime, and launch `AppRun` under X11  |

All six inspections require `resources/node-linux/bin/node`, the bundled Node server, and
the Node CLI. Launch uses Xvfb with isolated `HOME` and XDG directories and waits for a live
Electron renderer and bundled control service. The headless Wayland row instead uses an owner-only
runtime directory and a Weston software compositor. Containers test package structure, dependency
resolution, bounded X11 startup, and headless native-Wayland process readiness. They do not verify
real Wayland input/focus, a native desktop compositor, GPU acceleration, FUSE mounting, desktop-menu
integration, notifications through a real user session, distro upgrades, ARM64, physical macOS or Windows devices.
The Arch row is rolling-distribution readiness in a pinned official container, not native host or
desktop-session qualification; only retained green workflow evidence counts as release evidence.
The historical Rust performance numbers in this repository do not qualify the Node runtime.
The exact eight-hour Node soak remains unrun; this release does not claim stable qualification.

## Website and download links

GitHub Pages must use GitHub Actions as its build source. **Deploy website** builds with the repo
base path `/cmux-linux-alternative/` and only publishes after the versioned GitHub release assets
exist. Its manual dispatch supports subsequent website-only updates after verifying that release.
The site derives the version from the root manifest; every platform link addresses that exact tag.

## Rollback

Before publication, correct the candidate and qualify it again. Preserve published tags and
artifacts. For a regression, publish a notice and a new patch version; never reuse an escaped tag.
Keep checksums, smoke logs, and source identity with the release evidence. Do not delete user data
or modify shared development services during qualification.

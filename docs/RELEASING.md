# Releasing Agent Workspace

Releases are prepared by the manual **Release candidate** workflow. The workflow creates evidence
and, when explicitly requested from an existing matching tag, a GitHub **draft**. It never publishes
a release or promotes a stable channel automatically. A maintainer must review and publish the
draft in GitHub.

Only Linux x64 Node packages are built by the current release workflows. Native macOS and
Windows packaging requires separate implementation and qualification.

## Prerequisites and version gate

1. Update the root and desktop package versions to the same strict semantic version, including the
   desktop checksum/verify scripts' `--version` values. Do not add a `v` prefix inside the
   manifests.
2. Move the release notes from `[Unreleased]` into a non-empty `## [x.y.z] - YYYY-MM-DD` section in
   `CHANGELOG.md`. Keep an `[Unreleased]` section for subsequent work.
3. Run `pnpm test:release` and then
   `pnpm release:validate --version x.y.z --mode candidate --tag vx.y.z`.
4. Run the repository validation gate and build `pnpm package:linux` on the documented Linux build
   host. Verify `release/SHA256SUMS` independently.
5. Create and push the annotated `vx.y.z` tag only after review. Dispatch the workflow against that
   exact tag. Draft creation is refused when the selected ref is not the matching tag.

The `stable` channel accepts only a plain semantic version. The `beta` channel requires a
prerelease suffix such as `1.2.0-beta.1` and produces a prerelease draft. Neither channel is
published automatically.

## Feed-free packages and update metadata

`pnpm package:linux` is the release workflow default. It produces only the AppImage, deb, rpm, and
deterministic checksums; it does not embed a fabricated update feed. Channel metadata is a separate,
explicit Linux build using `package:linux:updates`
with a real HTTPS build URL and channel. Keep generated update metadata and every artifact it names
together. Never substitute a placeholder URL for a release. See `docs/UPDATES.md` for the metadata
qualification procedure.

## Automated evidence

The release-candidate workflow starts from a clean checkout, pins Node, pnpm, container image digests, and every third-party action,
installs with the frozen lockfile, runs `pnpm validate`, builds exactly these files, and verifies their checksums:

- `agent-workspace-x.y.z-x86_64.AppImage`
- `agent-workspace-x.y.z-x86_64.deb`
- `agent-workspace-x.y.z-x86_64.rpm`
- `SHA256SUMS`

The build receives GitHub's narrow `id-token: write` and `attestations: write` permissions only to
create GitHub/Sigstore build provenance for those subjects. Release assets are unsigned today;
SHA-256 and provenance authenticate workflow output but are not a substitute for distribution or
desktop code signing. A stable release remains blocked until maintainers choose, protect, and
document signing keys and signing verification.

Pinned Syft 1.48.0 emits both SPDX JSON and CycloneDX JSON SBOMs. The pnpm production license
inventory is retained with them. `pnpm audit --prod --audit-level high` and pinned Grype 0.116.0
fail on high or critical findings.

Candidate artifacts and security evidence are retained for 90 days. Main/scheduled package smoke
artifacts are retained for 14 days, and scheduled security/performance evidence for 30 days. GitHub
attestations follow repository attestation retention. The draft-release job alone receives
`contents: write`; validation, install, and security jobs are read-only.

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
integration, notifications through a real user session, distro upgrades, ARM64, macOS, or Windows.
The Arch row is rolling-distribution readiness in a pinned official container, not native host or
desktop-session qualification; only retained green workflow evidence counts as release evidence.
The former scheduled performance workflow depended on the removed Rust service. A Node release
needs new measured smoke and eight-hour soak evidence on the exact candidate before publication.
The historical Rust performance numbers in this repository do not qualify the Node runtime.

## Approval, publication, and rollback

Before publishing a draft, two maintainers should confirm the tag and commit, changelog, checksum
verification, all three clean-host jobs, both SBOM formats, license inventory, vulnerability gates,
and provenance. Confirm whether platform signing is complete and that the intended stable or beta
channel matches the version. If update metadata is being released, qualify it separately against the
real channel endpoint.

Copy and complete the [release qualification record](RELEASE_QUALIFICATION.md) for every candidate.
Keep it with the retained evidence. Missing checks stay `NOT RUN`; the template must not be used to
turn absent native, manual, signing, publication, or soak evidence into a passing claim.

To roll back before publication, delete the draft and tag, correct the source/version notes, and
create a new reviewed tag; never reuse a tag whose artifacts escaped the repository. After
publication, do not replace assets in place. Mark the affected release and channel unavailable,
publish a security or regression notice, revoke compromised signing material if relevant, and ship a
new patch version. Preserve the failed artifacts, checksums, SBOMs, provenance, logs, and audit
results for investigation.

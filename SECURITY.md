# Security policy

## Supported versions

The project is pre-alpha. Only the latest revision of the default branch receives fixes. There is
no published stable release or support window; one will be defined before version 1.0.

## Report a vulnerability

Use GitHub private vulnerability reporting for this repository. Do not disclose exploit details,
credentials, private update origins, or user data in a public issue, pull request, or discussion.

Include the affected revision, platform/package type, impact, minimal reproduction, and any known
mitigation. A maintainer will acknowledge the report as soon as practical and coordinate validation,
remediation, release, and disclosure with the reporter.

## Security boundaries

The renderer and all terminal/browser content are untrusted. The renderer has no Node.js access and
uses a narrow validated preload bridge; remote pages run in separate sandboxed native views without
a preload. The Rust service authenticates the owner-only local transport, and credentials never
belong in flags, logs, or process arguments. If secure OS credential storage is unavailable, the
desktop uses a fresh session-only token and persists no secret.

The public CLI is an authenticated, bounded set of operations rather than a generic command
channel. Its `--session-file` accepts only a discovery-record path and there is no token flag.

Updates are disabled unless both distinct trusted stable and beta HTTPS roots are configured in the
main process. The renderer selects a channel but cannot select a URL; check, download, and install
each require a separate user action. Default packages contain no fabricated feed. SHA-256 release
manifests and update-metadata SHA-512 hashes provide integrity checks but do not replace signing or
control of the hosting origin.

See [the detailed security model](docs/SECURITY_MODEL.md) for persistence, browser, protocol,
updater, diagnostic, and supply-chain invariants.

## Current audit status

Pinned GitHub workflows define JavaScript and Rust advisory gates, SPDX and CycloneDX SBOMs, a
packaged-artifact Grype high/critical gate, license inventory, and build provenance. These workflows
have not run in the current repository state, so their presence is not evidence of a clean scan.
There is no release-signing key or published release. Milestone 6 requires no unresolved critical
or high-severity findings before it can be established.

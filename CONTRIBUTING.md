# Contributing

This is an independent clean-room codebase. Do not copy source, assets, package identities,
trademarks, or documentation from another product. Implement documented behavior through original
design and keep the temporary project identity replaceable.

## Prerequisites and setup

Use Node.js 22.22.3, pnpm 10.34.5, a C/C++ build toolchain, and Electron's
Linux development libraries. Then run:

```sh
corepack enable
pnpm install --frozen-lockfile
pnpm dev
```

The checked-in protocol declarations live in `packages/protocol-client/src/generated`.
Update contracts and validation schemas together when the Node wire format changes.

## Validation commands

```sh
pnpm format:check
pnpm lint
pnpm typecheck
pnpm test
pnpm build
pnpm validate
```

`pnpm validate` is the complete local quality gate. TypeScript changes must pass Prettier,
ESLint, strict type checking, and the relevant Vitest/Node suites. Run focused Electron E2E under a display with:

```sh
pnpm --filter @agent-workspace/desktop test:e2e
pnpm --filter @agent-workspace/desktop test:a11y
```

## Packaging, performance, and release helpers

```sh
pnpm package:linux:dir
pnpm package:linux:local
pnpm package:linux
pnpm test:release
pnpm release:validate --version 0.1.0 --mode unreleased
pnpm --filter @agent-workspace/desktop performance:smoke -- --output /tmp/performance.json
```

`pnpm package:linux` creates feed-free x86_64 AppImage/deb/rpm candidates and deterministic
checksums. It is not publication. Update metadata requires the explicit command and real HTTPS
build root in [Desktop updates](docs/UPDATES.md). An eight-hour soak is intentionally opt-in:

`pnpm package:linux:local` builds only the x64 AppImage and atomically updates a stable per-user
AppImage path, hicolor icon, and desktop entry for repeated local launcher testing. Its staging
directory is separate from the strict versioned release-artifact set.

```sh
pnpm --filter @agent-workspace/desktop performance:soak -- --output /tmp/soak.json
```

Do not shorten or describe the smoke run as the soak. Follow [Performance](docs/PERFORMANCE.md) and
[Releasing](docs/RELEASING.md) for qualification and evidence handling.

## Change expectations

1. Start an RFC for protocol, persistence, security-boundary, update/release trust, plugin, or
   major UI architecture changes. Maintainers may require an ADR under `docs/decisions/`.
2. Keep changes focused and include tests proportional to risk. User-visible behavior needs
   documentation and accessible labels/states.
3. Update [the dependency record](docs/DEPENDENCIES.md) with the purpose, license, owner boundary,
   and exact version policy for every new direct production dependency.
4. Keep CLI examples derived from `--help`, settings defaults/bounds derived from Node contracts,
   and milestone/release claims tied to retained evidence. Distinguish implemented, locally
   validated, CI-defined, and unrun work.
5. Describe security impact, test evidence, documentation changes, and follow-up gaps in the pull
   request. Never include credentials, session records, private diagnostic data, or update URLs.

## DCO and review

Sign every commit with `git commit --signoff` to certify the
[Developer Certificate of Origin 1.1](https://developercertificate.org/). Review may request
additional platform, clean-package, accessibility, performance, or security evidence before merge.

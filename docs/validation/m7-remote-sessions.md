# M7 remote-session validation

Status: M7-AC-01 through M7-AC-03 are implemented and independently re-reviewed clean. The native
host-key, credential rotation, reconnect, and remote tmux boundaries advertise
`remote-sessions-v1`. Exact-candidate global and release qualification remains pending.

## Hermetic SSH/tmux evidence

The fixture exercises a real Ed25519-only loopback `sshd`, public-key authentication, stock
OpenSSH, and tmux. It passes the exact one-string discovery command emitted by `SshLaunchPlan` and
requires the response to contain bare, bounded tmux session names. This acknowledges that OpenSSH
passes the internally owned command through the remote account's login shell; no caller-provided
command or shell syntax is accepted.

Host run (tmux 3.7b):

```sh
node scripts/qualification/m7-hermetic-remote.mjs \
  /tmp/cmux-tmux-3.7b.6wAdmT/install/bin/tmux
```

Observed: strict Ed25519/public-key authentication and exact discovery passed;
`attachDetachReconnectCovered=false`, `networkLossCovered=false`, and
`qualificationComplete=false`.

Root-owned container run:

```sh
docker build -f scripts/qualification/m7-hermetic-remote.Dockerfile \
  -t cmux-m7-hermetic:local .
docker run --rm cmux-m7-hermetic:local
```

Observed: tmux 3.3a, strict Ed25519/public-key authentication,
`exactRemoteCommandDiscovery=true`, `attachDetachReconnectCovered=true`, and
`networkLossCovered=true`. The fixture killed two server-owned processes for the live SSH
connection, observed the original transport fail, verified the tmux session survived, reattached
that exact session through a fresh strictly authenticated connection, and found exactly one created
session. Compact evidence from 2026-07-20:

```json
{
  "schemaVersion": 1,
  "scope": "hermetic-transport-fixture",
  "host": "ipv4-loopback",
  "hostKeyAlgorithm": "ssh-ed25519",
  "tmuxVersion": "tmux 3.3a",
  "strictHostKeyAuthentication": true,
  "publicKeyAuthentication": true,
  "fixedTmuxCreateStayedLive": true,
  "exactRemoteCommandDiscovery": true,
  "attachDetachReconnectCovered": true,
  "networkLossCovered": true,
  "networkLossEvidence": {
    "interruptedServerProcesses": 2,
    "originalTransportExited": true,
    "exactSessionReattached": true
  },
  "exactCreatedSessionCount": 1,
  "qualificationComplete": true
}
```

`qualificationComplete` is true only for this hermetic fixture in persistent mode after every fixture assertion succeeds,
including transport interruption, exact reattach, and the single durable tmux identity check. The
field does not claim application, package, platform, or release qualification.

## Focused verification

```sh
cargo test -p agent-workspace-storage remote_sessions::tests --lib
cargo test -p agent-workspace-terminal-runtime remote::credential_broker::tests --lib
cargo test -p agent-workspace-control-server remote_sessions::tests --lib
cargo test -p agent-workspace-protocol remote_sessions::tests --lib
pnpm --filter @agent-workspace/protocol-client exec vitest run \
  src/remote-session-schemas.test.ts
pnpm --filter @agent-workspace/desktop exec vitest run \
  src/main/desktop-ipc.test.ts \
  src/main/service-utility-runner.test.ts \
  src/preload/index.test.ts \
  src/renderer/src/workspace/RemoteSessionsSettings.test.tsx
```

These cover durable deletion/enrollment reconciliation, target fences, exact Secret Service match
policy, fd-only credential handoff, main-owned destructive confirmation, protocol/preload privacy,
modal keyboard behavior, and explicit IPv6 rejection for v1. The control-server suite additionally
proves:

- `connected/lastVerified -> reconnecting/lost` on the exact generation after transport loss;
- one bounded failed discovery followed by one successful exact attach, without replaying remote
  create or duplicating attach;
- stable target, session, workspace, pane, tab, and tmux identity across reconnect;
- successful tmux discovery plus exact attach atomically records `connected/lastVerified`;
- restart reconciliation to `detached/unknown` without fabricating remote process health; and
- detach cancellation while reconnecting before any timer-driven remote dispatch.

Observed on 2026-07-20: storage remote tests 5/5, terminal remote tests 5/5, and
control-server remote tests 8/8 passed. Strict clippy reported no errors in the changed remote
files. An independent re-review on 2026-07-21 found the native host-key, credential rotation,
reconnect, restart reconciliation, and confirmation boundaries clean against M7-AC-01 through
M7-AC-03.

## Scope boundary

This evidence covers SSH/remote tmux ownership and focused M7 acceptance. Remote browser routing
and local notification relay are not implemented. Final `pnpm validate`, global suites, packaged
candidate execution, native-platform/manual checks, signing, hosted release, and publication have
not been established by this record.

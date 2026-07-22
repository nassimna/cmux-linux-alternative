# 0012: SSH and remote tmux trust boundary

**Status:** Accepted

## Context

M7 adds remote targets, SSH process ownership, reconnect/detach, and remote tmux discovery/attach/
create. The repository currently has no SSH, tmux, or credential-provider implementation. Local PTY
launch metadata is intentionally command-free, while terminal descriptors and diagnostics may cross
process boundaries. Overloading those records with credentials, arbitrary SSH options, or remote
commands would leak secrets and create a shell-injection surface.

M7 depends on an accepted remote trust decision. Remote process health cannot be inferred from the
local SSH child alone, and host-key changes must fail closed.

## Decision

### Durable non-secret model

The service advertises optional `remote-sessions-v1`. SQLite schema version 10 stores bounded
validated `RemoteTarget` and `RemoteSession` records separately from local `TerminalLaunchSpec`.
There are at most 128 targets and 256 sessions.

`RemoteTarget` contains an opaque UUID, normalized display label, canonical IDNA host, port, bounded
user label, closed authentication method, app-owned known-hosts scope/version, closed host-key state,
opaque credential reference, and revision/timestamps. `RemoteSession` contains an opaque UUID,
target ID, exact workspace/pane/tab binding, optional validated tmux identity, closed connection
state, attempt generation, reconnect policy, and last verified observation. Local PID, PTY runtime
ID, credential material, private-key bytes, agent socket, proxy command, arbitrary SSH options,
remote shell text, and terminal content are never durable remote fields.

Service restart retains target/session/tmux identities but creates a new local transport/PTy runtime
and truthfully reconnects or reports unavailable. Detach releases local transport and does not imply
remote process termination. Terminate is a separate confirmed action.

### Credential and host-key boundary

Credentials are owned by a trusted `CredentialProvider` abstraction. Version 1 supports public-key
signing only. Linux production loads an approved key from Secret Service/keyring into a short-lived,
target/attempt-scoped signing broker and returns only an opaque per-profile reference to the service.
Stock `ssh` receives only an owner-only ephemeral agent socket through `SSH_AUTH_SOCK`; key bytes and
passphrases never reach it. The socket path is never durable or logged, expires with the attempt, and
is removed after all requests are fenced. Broker memory is zeroized on completion. Secrets never
reach renderer/preload, protocol snapshots, config, SQLite, argv, other environment values, logs,
audit, diagnostics, or backups. Unlock is an Electron-owned confirmed provider action. No plaintext
fallback, password mode, caller-supplied agent, or user SSH config is supported in v1. Delete/rotation
invalidates dependent attempts explicitly.

Each profile uses an owner-only app-managed `known_hosts` file. First contact records no key until a
trusted Electron prompt displays canonical host/port, algorithm, and fingerprint and the user grants
a one-shot confirmation bound to target revision and presented key. Subsequent connections use
strict checking. Changed, revoked, downgraded, or additional unexpected keys fail closed; replacing
trust requires a separate credential-independent confirmation. There is no `accept-new`, silent
fallback to insecure checking, or renderer-supplied trust boolean.

### SSH process and argv policy

The service resolves one approved `ssh` executable at startup and owns it inside process containment
and a PTY. It invokes `ssh -F /dev/null` and constructs argv from validated atoms with `shell = false`.
Version 1 permits only fixed
port, canonical destination, app known-hosts path, strict host-key/batch/TTY modes, closed
authentication policy, and one internally constructed tmux operation. Arbitrary `-o`, config-file
injection, `ProxyCommand`, local/remote/dynamic forwarding, agent forwarding, control-master paths,
environment injection, and caller-provided remote command strings are forbidden. Later support for
any item requires an explicit capability/threat decision.

The attempt-scoped credential broker is the only authentication input. Terminal descriptors expose a
generic remote transport label, never the full argv, broker socket, destination credential syntax,
or private paths.

### Remote tmux compatibility

Version 1 supports tmux 3.2 or newer using the default remote server only. Session names are 1–64
ASCII characters from `[A-Za-z0-9_.-]`. Discovery invokes a fixed `tmux list-sessions` format with a
strict bounded parser: at most 128 rows and 64 KiB output. OpenSSH necessarily passes the one
internally constructed command string through the remote account's login shell. The fixed discovery
format is POSIX-single-quoted, and attach/create names are restricted to `[A-Za-z0-9_.-]`, so no
caller-controlled shell syntax can enter that boundary. Caller-selected socket paths,
server commands, format strings, hooks, environment assignments, or arbitrary tmux subcommands are
forbidden. Missing/older tmux yields an explicit unsupported outcome.

### State, reconnection, and exactness

Remote lifecycle is:

`created -> trustRequired | credentialRequired | connecting -> connected | reconnecting | detached -> failed | closed`.

Remote observation is separate: `unknown`, `lastVerified`, or `lost`. Local SSH exit or network loss
sets remote health to unknown/lost and exposes disconnected/reconnecting/detached state; it never
fabricates remote process running/exited status. Reconnect uses capped attempts, exponential backoff
with jitter bounds, exact target/session/tmux identity, and a monotonically increasing attempt epoch.
Stale reader/exit/timer callbacks cannot overwrite a newer connection. A reconnect always uses
`tmux attach-session` for the durable tmux name, including when the original operation created that
session; `tmux new-session` is never replayed during recovery. Successful version discovery plus an
exact create/attach is authoritative current evidence and atomically records
`connected/lastVerified`. Detaching while reconnecting is the explicit cancellation boundary and
fences every pending timer before another remote dispatch.

Connect, trust, discover, attach, create, detach, reconnect, and terminate carry expected revisions
and idempotency UUIDs. Intent is durable before side effects; exact terminal results use the durable
namespaced idempotency mechanism. Output, rows, sessions, timeouts, reconnect attempts, event queues,
and retained results are bounded. Cancel after remote dispatch reports that cancellation is not
guaranteed unless the owned transport proves it stopped.

SSH/tmux status feeds a bounded projection and the fixed card slot, but the remote catalog/runtime
remains authoritative. Only actionable failure/trust/credential states raise attention, targeted to
the exact workspace/pane/tab/session. Rust DTOs are canonical with strict generated TypeScript/Zod
and capability-gated CLI/UI. Older services hide remote surfaces.

## Consequences

- Host-key changes fail closed and secret material cannot enter application data flows.
- The service owns contained SSH processes without exposing a generic remote shell API.
- Network loss is represented truthfully and cannot masquerade as remote process health.
- Detach/reconnect/restart preserve durable target, remote session, and tmux identity while local
  runtime identity may change.
- Hermetic sshd/tmux, host-key/credential, argv/parser, loss/reconnect/race, restart/idempotency,
  migration/recovery, secret-scan, CLI/UI/accessibility, and security review tests are required before
  M7 qualification. A real tmux-enabled Linux runner remains required for compatibility evidence.
  The hermetic container interrupts the server-owned process for one live SSH connection, observes
  the original client fail, verifies the exact tmux session survived, and attaches it exactly once
  through a fresh strictly authenticated transport.

## Alternatives considered

- Storing passwords/private keys in SQLite or config was rejected because those stores, backups, and
  diagnostics are not credential vaults.
- Trust-on-first-use without an exact prompt was rejected because it silently accepts interception.
- Passing arbitrary SSH options or remote command strings was rejected because it enables policy
  bypass, forwarding, config injection, and shell execution.
- Treating local SSH child liveness as remote process health was rejected because network and remote
  session state are independent.
- Persisting local PTY/runtime IDs for restart was rejected because those identities die with the
  service process.

# 0009: Safe project custom commands

**Status:** Accepted

## Context

M4 permits project-defined custom commands in the public action registry, palette, and shortcuts.
Project files are untrusted input. A raw shell string, inherited environment, renderer-side process
launch, or caller-supplied confirmation could bypass the existing preload, path, and command policy
and leak credentials.

## Decision

Project custom commands are a bounded configuration family exposed through `actions-v1`. A project
may define at most 64 commands. Each has an immutable namespaced ID, normalized title of at most 120
Unicode scalars, an executable path or approved executable name, at most 64 literal argument
elements of 1,024 scalars each, a closed working-directory policy, optional logical shortcut, and an
allowlist of at most 32 environment variable names. The complete
definition is capped at 16 KiB and rejects controls, unknown fields, duplicate IDs, conflicts, and
ambiguous `null` values.

Execution uses direct argv process spawn with `shell = false`. No renderer JavaScript, IPC channel,
template expansion, command substitution, glob expansion, or raw shell string is supported. A
future shell mode requires a separate capability and threat-model ADR; it is not an implicit escape
hatch in v1.

The service runtime is the sole process owner and executes the command in the existing process-
containment boundary after any Electron confirmation. Executable, working directory, and declared
file arguments are canonicalized by the service immediately before execution. Project-relative targets must remain beneath the
authorized project root after symlink resolution. Traversal, symlink escape, device/special files,
relative executable ambiguity, and paths outside policy fail closed. Importing or discovering a
project command never executes it.

The child environment starts from a minimal fixed allowlist. A requested name may pass through only
when policy permits it; secret-looking names and desktop/control credentials are always denied.
Values never enter renderer state, protocol results, audit output, or diagnostics. Stdin is closed by
default, output capture is bounded and redacted, runtime duration is capped, and cancel terminates
the owned process tree through the process-containment boundary.

Every project-defined command requires trusted Electron confirmation on every invocation. A future
audited read-only allowlist may waive confirmation only for exact service-defined executable and
argument schemas; project content cannot select or downgrade the confirmation class. Confirmation is bound to the
invocation ID, provider/window generation, a hash of the exact validated definition/parameters, and
a short expiry. It cannot be supplied in socket/CLI parameters or reused after any change. Headless
invocation of an interactive command fails `confirmation_required` when no eligible desktop
provider exists.

Definitions join the public registry only after validation and project trust policy. Conflicting
shortcuts are reported through the existing typed conflict model. Invocation uses the durable action
idempotency and provider state machine from ADR 0008. Audit stores only IDs, policy decisions,
relative/redacted location categories, sizes, duration, exit class, and redaction counts—never raw
argv, environment values, stdout/stderr, credentials, or absolute paths.

## Consequences

- Project commands cannot bypass fixed preload or process ownership with arbitrary shell syntax.
- Confirmation represents an exact trusted native interaction, not a caller-provided boolean.
- Path and environment policy prevents common traversal, symlink, and secret-inheritance failures.
- Config migration/bounds, direct-argv behavior, path/symlink escape, environment filtering,
  confirmation forgery/replay, containment/cancel, redaction, palette/shortcut, and CLI tests are
  required before M4 qualification.

## Alternatives considered

- Raw command strings were rejected because quoting and interpolation cannot be made portable or
  safely composable with untrusted values.
- Renderer-side process launch was rejected because it would expose Node/Electron privilege.
- Inheriting the full desktop environment was rejected because it commonly contains credentials.
- Project-file `confirmed: true` was rejected because untrusted content cannot authorize itself.
- Reusing terminal shell-path configuration was rejected because choosing an interactive shell is
  not authority to execute arbitrary shell programs.

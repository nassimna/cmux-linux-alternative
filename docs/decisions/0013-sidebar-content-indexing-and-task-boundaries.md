# 0013: Sidebar, content, indexing, Vault, and task boundaries

**Status:** Accepted

## Context

M8 adds a right-side dock, TextBox, Vault, Task Manager, file/Markdown/diff viewers, global search,
and recently closed. Today only the left workspace sidebar exists and its width is renderer-local.
There is no generic filesystem, indexer, transcript, or process-management API. Adding generic
paths, HTML, search results, or process IDs to preload would violate fixed-operation IPC and allow
traversal, symlink races, content execution, PID reuse, or transcript leakage.

M8 also depends on the multi-window, action/provider, browser automation, agent privacy, and remote
truthfulness decisions in ADRs 0007, 0008, 0010, 0011, and 0012.

## Decision

### Fixed sidebar surfaces and persistence

The service advertises optional `sidebar-surfaces-v1`. A closed registry contains only `textBox`,
`vault`, `taskManager`, `files`, `markdown`, `diff`, `search`, and `recentlyClosed`. `ApplicationState`
and SQLite schema version 11 persist placement for at most 16 windows and all eight fixed surfaces:
enabled/order, side, width, and last selected available surface. Width is clamped to 240–720 logical
pixels and at most 45% of the live window. Missing,
unknown, corrupt, or unavailable surfaces fall back safely without blocking window restore.

Renderer owns only ephemeral focus, hover, scroll, preview selection, drag state, and temporary dock
expansion. It never invents durable enablement or document/task success. Electron main binds the
fixed bridge to the exact sender window/generation; no generic filesystem, process, search, browser,
or HTML IPC is exposed.

### Authorized workspace content

A trusted service `WorkspacePathProvider` issues opaque document IDs after canonicalizing an exact
existing path under an authorized workspace root. Every open/read/diff/search/save operation
revalidates root, ancestry, file identity, type, size, and authorization immediately before access.
Traversal, absolute substitution, symlink/hardlink escape or replacement races, device/special
files, FIFOs, sockets, unsupported encodings, and outside-root targets fail closed. Atomic writes
use owner-safe temporary files in the authorized directory, revalidate before rename, and never
follow a substituted target.

Preview contracts are chunked and bounded. Plain files and diffs return text plus display metadata,
not caller paths. Binary/oversized content has an explicit unavailable summary. Markdown parses to a
fixed safe AST supporting headings, paragraphs, lists, emphasis, links, and code. Raw HTML is text;
scripts, images/data URLs, remote embeds/fetches, executable directives, unsafe schemes, and focusable
injected controls are forbidden. HTTP/HTTPS links open only through the existing confirmed external
action with no opener.

At most 64 `TextBoxDocument` records are retained. Each is a versioned bounded UTF-8 document linked
to a workspace/window, with opaque ID, title of at most 120 scalars, content revision, timestamps, and
at most 256 KiB text. Overflow fails atomically. Save uses expected revision and
idempotency; conflicts never overwrite. TextBox content is non-executable and excluded from generic
diagnostics.

### Dedicated bounded indexing and Vault

Search/Vault use an index at `<profile-data>/index/v1/search.sqlite3`, beneath an owner-only `0700`
directory with `0600` files, never the application snapshot or normal backups. Sensitive fields are
encrypted with XChaCha20-Poly1305 using a per-profile 256-bit key held by Secret Service; searchable
tokens are keyed hashes and snippets are encrypted. If the keyring is unavailable, Vault and durable
content indexing remain disabled. It is
disabled until the user authorizes exact roots or accepted agent formats. Version 1 indexes bounded
text tokens and redacted location metadata. Structural parsers exclude known credential fields, but
ordinary user text may still contain secrets; consent UI states this explicitly and content redaction
is best-effort, never an absolute guarantee. The index excludes environment, terminal output,
browser data, and unapproved roots. It is capped at 512 MiB, 100,000 documents, 10 million tokens,
100 results per query, 512-scalar snippets, and 365-day retention. Oldest unpinned documents are
pruned deterministically before new indexing; pinned/consented-source overflow pauses with a visible
limit error. It has ignore rules, per-root/per-agent exclusions, delete/forget/rebuild/export controls, schema
migration and corruption recovery. Deleting source authorization deletes its index entries.

Indexing runs as low-priority cancellable work with bounded queues, file/byte/time budgets, backoff,
and checkpoints. It cannot occupy interactive Tokio workers or starve PTY/control/browser traffic.
Search returns bounded snippets from authorized current content and revalidates the opaque document
before open. Index files and transcript content are excluded from generic logs, diagnostics, recovery
exports, and crash reports.

Vault is local-only by default and accepts only explicitly supported, strict, versioned agent
transcript parsers. Each adapter declares format/version, locations, exclusions, and retention. User
consent is per agent/root. Raw transcripts remain in their source; Vault stores only the bounded
local index necessary for search and authorized previews. Unknown formats, malformed records, secret
fields, and excluded sessions are skipped with content-free errors. There is no cloud sync or generic
agent directory crawl in v1.

### Authoritative Task Manager and recently closed

Task Manager projects service-owned terminal, agent, browser automation, remote session, and custom-
command/action-process records
with opaque session identity, owner, closed lifecycle/observation state, bounded labels, resource
summary, and revision. A PID may be an internal observation only and is never the public target.
Remote state preserves `unknown/lost` independently from local SSH liveness. Stale observation and
PID reuse cannot retarget an action.

Cancel, detach, terminate, and force-terminate are separate typed actions. Destructive execution
requires exact session ID/generation/revision and trusted confirmation bound to invocation/provider/
window/hash/expiry under ADR 0008. Provider loss, stale target, replay, and process exit converge on
one durable outcome. Task Manager never signals arbitrary OS processes.

Schema version 15 adds bounded `task_confirmations` and `task_action_outcomes` tables. The service
issues and burns each destructive challenge once, binding action, authoritative task kind and exact
session generation/revision, provider epoch/lease, window generation, request hash, expiry, and a
hashed nonce. Only the identical idempotent retry may resume convergence after a consumed challenge;
mismatches burn the challenge and service restart invalidates every unconsumed challenge. Version 1
projects and acts only on agent and remote-session records because those categories expose explicit
authoritative owner interfaces. Terminal, browser-automation, and custom-action categories remain
omitted until their owners expose equally fenced Task Manager operations.

M8 exposes list/filter/search/reopen UI over ADR 0007's bounded redacted closed records. Reopen uses
the record's authorized descriptor and exact action; search does not add terminal/browser history or
secrets to the record.

### Contracts and compatibility

Rust DTOs are canonical; generated TypeScript/Zod rejects unknown fields, ambiguous nulls, unsafe
IDs/revisions, paths, unbounded chunks/snippets/content, unsupported AST nodes, and stale task
targets. Commands and events are fixed, capability-gated, paginated, cancellable, and backpressured.
Older services hide the dock and remain otherwise usable.

## Consequences

- Files, previews, diffs, search, and reopen remain confined to exact authorized roots and safe
  untrusted-content rendering.
- Vault is local, consented, bounded, excludable, forgettable, and absent from generic diagnostics.
- Task Manager acts on authoritative sessions rather than renderer/PID guesses.
- Sidebar placement restores durably while interaction state remains renderer-local and accessible.
- Path/symlink race, hostile Markdown/HTML, index starvation/cancellation, transcript parser/privacy,
  retention/migration, secret-scan, PID-reuse/task race, confirmation, search/reopen, keyboard/zoom/
  forced-colors, renderer/window restore, visual, and packaged E2E evidence are required before M8
  qualification.

## Alternatives considered

- Generic path-based preload APIs were rejected because a compromised renderer could escape project
  authorization and race symlinks.
- Rendering HTML from Markdown was rejected because sanitization would expand the trust boundary for
  no required M8 outcome.
- Storing the search/Vault index in the application snapshot was rejected because content volume,
  privacy, rebuild, and retention differ from durable user intent.
- Indexing all transcripts by default was rejected because agent content requires consent,
  exclusions, and format-specific parsing.
- Using PID as a task identity was rejected because PIDs are reused and do not represent remote,
  browser, or agent ownership.
- Persisting only sidebar state in localStorage was rejected because multi-window restore and service
  ownership require a checked durable placement.

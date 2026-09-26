# 0014: Node service migration with full feature parity

> Decision record with dated migration observations. The active Linux desktop now starts
> the Node service and the Rust source/build tree has been removed. Earlier observations
> below about Rust ownership and future crate removal are historical. Fresh-profile
> operation does not qualify migration of an existing profile. See
> [Architecture](../ARCHITECTURE.md) for the current path.

**Status:** Linux Node default implemented; existing-profile migration and release qualification pending

## Context

The current desktop is split between a sandboxed React renderer, Electron main, and a supervised
Rust control service. The Rust service owns the schema-v15 SQLite database, domain mutations,
remote sessions, agent sessions, terminal processes, encrypted content, diagnostics, and the CLI
protocol. Maintaining those features requires Rust expertise that the product owner does not want
as an ongoing prerequisite. The product owner selected a Node backend and required full feature
parity for the first release on that backend.

The target repository organization follows the useful boundaries in T3 Code: a separate server,
a separate web UI, a thin desktop shell, shared contracts, and a shared client runtime. This is an
architectural reference; no product code or assets are copied. T3 Code's
[architecture overview](https://github.com/pingdotgg/t3code/blob/main/docs/internals/overview.md)
places execution with the workspace-owning server and keeps connection state in its client
runtime; those are the boundaries used here with the selected Hono and plain TypeScript stack.

## Decision

- Use Node.js and plain TypeScript services. Hono owns the HTTP and WebSocket boundary. Effect is
  not part of the new backend.
- Qualify the Node release on Linux first. Other platform support requires its own native build,
  packaging, and real-app evidence; it is outside this release gate.
- `apps/server` owns domain state, persistence, terminal and agent runtimes, and authenticated
  transport. `packages/contracts` owns validated wire contracts and
  `packages/client-runtime` owns client transport and response validation.
- `apps/web` owns the React UI. During migration it still consumes the legacy desktop bridge;
  the Node cutover will replace its Rust-backed commands through shared contracts and client
  runtime. Keep `apps/desktop` responsible for Electron windows, browser views, native credentials,
  system integration, packaging, and a narrow preload. Add a TypeScript `apps/cli` that uses the
  same contracts.
- The new server binds loopback by default and requires a high-entropy bearer token. Desktop main
  owns the token; renderer code does not receive it. Remote access needs a separately reviewed
  authentication and exposure design.
- Preserve raw PTY bytes, ordered output, bounded journal memory, checkpoints, and explicit
  resynchronization. Native addons must be built and packaged for each supported platform.
- Do not switch the desktop, CLI, or live database to Node until every row below is complete and
  tested against the current implementation's contracts. During migration the Rust service remains
  the production owner of existing user data.

| Required parity area       | Node cutover evidence                                                                                     |
| -------------------------- | --------------------------------------------------------------------------------------------------------- |
| Workspace and window state | Full topology, tabs, panes, groups, layouts, history, multi-window ownership, revisions, and replay       |
| Terminals                  | Local and remote PTYs, process cleanup, restart, metadata, checkpoints, reload recovery, and backpressure |
| Remote sessions            | SSH trust, host keys, credential handoff, tmux discovery/reconnect, and target/session persistence        |
| Agent sessions             | Provider adapters, lifecycle, restore/fork/hibernate, teams, catalog, attention, and concurrency fences   |
| Sidebar and content        | Notes, tasks, links, Vault consent/encryption, search, retention, forget/rebuild, and export              |
| Actions and browser        | Safe project commands, provider leases, browser automation, native view coordination, and confirmation    |
| Settings and notifications | Typed configuration, shortcuts, durable notifications, attention, and native forwarding                   |
| Operational surface        | CLI commands/hooks, diagnostics/recovery, updates, packaging, permissions, and native platform tests      |

Migration of the existing database is an explicit release gate. Node must inspect schema version 15
read-only, reject future or corrupt schemas, and create a verified backup before any write. Schema
changes must be transactional and preserve IDs, revisions, ownership, encrypted content, key
material references, idempotency records, and recovery behavior. Only one service may own a live
database at a time. Test migrations on disposable copies, including rollback and interrupted-write
cases. The first Node release cannot initialize an empty replacement database for an existing user.

The initial `apps/server` implementation covers the authenticated terminal API, real local PTY
runtime, read-only schema-v15 qualification, an optional authenticated snapshot reader, and a
verified backup helper tested on disposable databases. A separate Node working copy supports
revision-fenced workspace selection, reordering, metadata edits, terminal-backed creation,
workspace closure, multi-selection, batch closure, canonical reordering, terminal restart, pane
focus, resize, split and close, tab selection, terminal and browser tab creation, tab reordering
and cross-pane moves, recorded tab closure, and tab titles with atomic idempotency results, plus
workspace pinning, group organization, and saved-layout storage/export/import/apply with validated
read projections, checked against
Rust-generated fixtures. Creation is available
only when an explicitly restored terminal runtime is supplied; a failed commit terminates its
new PTY. Closure commits before terminating old PTYs and replaces the final workspace with a
new terminal. Restart launches a replacement PTY before committing its revision, then terminates
the old PTY; a failed commit retains the old PTY. Linux runtime metadata discovers TCP listeners
from the PTY process tree through `/proc`. The React UI and desktop bridge contracts live in
`apps/web` and `packages/contracts`;
Electron still builds the UI into its packaged renderer. The qualification is not a
write-readiness gate. The bundled server can explicitly prepare and run a verified isolated
copy, including terminal restoration and creation. A Rust-checked Node projection now supplies
ordered workspace, pane, tab, attention, browser, and shortcut data for `workspace list`. An
opt-in, private Linux discovery record lets
the transitional `apps/cli` inspect the Node service, create, pin, and reorder workspaces, and create
or send input to local terminals without exposing its bearer token to the
renderer. An unpackaged or explicitly staged Linux desktop can opt into a separate,
private-copy Node sidecar probe;
Electron main holds the bearer token and uses the shared client runtime to verify identity and
snapshot access. The renderer and live database remain Rust-owned. An opt-in Linux directory
package now carries the staged Node CLI and runtime; the default package remains Rust-only.
The Node server advertises only commands whose optional owners are supplied.
The isolated Node writer now reads remote target/session rows and reconciles stale process-local
session states after restart. Its bare metadata-only target creation route is withheld because a
usable target requires credential enrollment. Online new-target enrollment, interactive tmux
transport, reconnect, and deletion each have separate opt-in Node paths. A packaged Linux
loopback run now covers their combined enrollment, trust, SSH/tmux, and cleanup path; broader
remote-host qualification remains open.
Node has a separately exercised Linux host-key authority. In explicit isolated-copy mode it can
verify a previously approved key, prepare durable remote session intent, and perform one-use
first-contact scan and trust decisions through the authenticated HTTP API. An additional opt-in
transport mode uses an
exact Secret Service credential and attempt-scoped broker to run bounded tmux version/session
probes through stock SSH after host-key verification. The opt-in activation path persists fenced
connect attempts, exposes a live interactive SSH PTY for a prepared session, and schedules bounded
reconnect attempts after local transport exit. Its short signing socket handles OpenSSH
`session-bind@openssh.com` with the pinned host key. Tmux discovery requests no TTY and recognizes
tmux's exact no-server response as an empty list. Electron main can now stop the isolated writer,
run inherited-FD enrollment, and resume its copy for an existing target; the renderer's Rust
credential flow is unchanged. A packaged disposable desktop run attached to task-only loopback
SSH/tmux and echoed terminal output. This does not establish arbitrary-host support or live data
cutover. Rust's approved known-hosts files are profile files outside SQLite. On first opt-in
remote-mode startup, Node copies only validated `trusted`
records into a fresh owner-only root when source and working directories are separate. Missing or
unsafe trusted records abort startup; same-directory copies cannot enable remote mode.
The isolated Node writer also serves read-only schema-v15 agent catalog list and session get
routes. It projects bounded session, team, and attention metadata through the Rust protocol
contracts, validates exact bindings, and omits storage-only checkpoint and operation fields.
The audited Codex adapter and an exact live terminal check now gate `agent.catalog.register`.
Agent attention setting now uses the Rust-v15 operation journal and exact session and attention
revision fences; a focused Rust fixture covered replay, conflict, and stale writes.
`agent.restore.assess` persists an exact assessment operation. Live reattachment requires the
terminal identity verified during registration or resume in the current service process; a shell
recreated after restart is not agent evidence. `agent.session.restore` records pending intent and
advances the attempt epoch before audited Codex resume through a sealed executable and PTY
replacement. Startup interrupts unproven pending attempts. The adapter accepts CLI `0.142.4`
and `0.156.1` for resume and fork, with exact version binding to each catalog session and a
separate fork allowlist. Startup recovers orphaned forks before HTTP serving; the fork route is
advertised only when recovery and the exact audited provider are available. A disposable
`0.156.1` thread authenticated through an owner-only private profile, restored its original
exchange in a live Node PTY, forked to a distinct record and live PTY, and restored that fork
after a backend restart. Codex creates fork rollout files with mode `0644`; the adapter now
tightens only the exact newly returned private record to `0600` after owner, inode, path, and
symlink checks. The strict read guard remains in place. The task-only private sign-in material
was removed after validation; the default Codex auth file was unchanged. This proves the
isolated Node path, not migration of an existing live agent profile. Hibernation has
challenge storage and a bounded confirmation service that requires an injected exact
provider/window and current PTY authority; it fails closed without that authority. The Node
desktop exposes each agent action only when its isolated sidecar qualifies the corresponding
provider capability. Hibernation remains hidden from the Node Settings UI pending a packaged
live-session disposition check.
The qualified Node desktop routes agent catalog list, exact restore assessment, registration,
restore, and fork for the owning window. It advertises those operations individually while
withholding the broad `agent-sessions-v1` capability. A packaged v31 run displayed the task-only
catalog, assessed `toolResume`, restored the exact thread with outcome `resumed`, and created a
new fork record through Settings. The service advertised its verified Codex version `0.156.1`,
which the desktop used for registration. The task-only auth copy was removed after desktop Quit.
Copied-mode startup now creates an owner-only Codex home inside the working database directory,
binds it to the exact source, working file, and database inode, and rejects inherited live
profiles or unmarked data. Assessment checks this binding before any thread read. The copied
profile starts unsigned in; copied-mode register, restore, and fork routes stay closed until
that private provider passes login and exact thread-binding checks. An opt-in read-only probe
can inspect one explicit thread ID under that private home, with owner/inode checks and a
sanitized provider environment. It does not enable mutations by itself.
The isolated Node API also lists the four closed built-in public action definitions with
one-use, five-minute, bounded discovery cursors tied to its writer epoch. The three service-owned
Tier A actions now invoke through an atomic snapshot and exact-result transaction. A bundled
server and CLI interaction covered pin, rename, collapse, replay, and a changed-correlation
conflict. Node now exposes `action.cancel` through HTTP and the staged CLI. Its current service
actions finish synchronously and never create cancellable rows, so canceling their invocation
returns HTTP 404 `action_not_found`, as Rust does. A packaged CLI invoked a pin action and
received this exact response for its invocation. Pending desktop and project action cancellation
remain gated.
The isolated Node writer also serves sidebar placement and TextBox pages plus revision-checked,
idempotent save/create/delete operations. TextBox content is returned only while its workspace
remains in the owning window, using a single SQLite read transaction for the document and
ownership check. A separate Linux Files service now lists owner-authorized workspace roots and
directories, issues opaque document descriptors, and returns bounded UTF-8, safe Markdown, and
diff previews. Its Linux rename-exchange helper now supports revision-checked atomic file save;
a bundled server and CLI exercised a disposable workspace file. A gated Linux encrypted search
index can load a Rust-compatible key from Secret Service on an isolated copy. A fresh opt-in
Hono probe against the unlocked KDE Wallet exercised source consent, rebuild, query,
stale-file invalidation, and exclusion with a task-only encrypted key. The private Codex
transcript source remains unverified. The
opt-in desktop demo now routes Files root/directory/document reads and bounded text saves through
Electron main with window-bound opaque grants. A packaged disposable run listed an owner-owned
workspace, read a text file, rendered Markdown and a diff, and used the Files sidebar to preview
and save a file. A subsequent external edit caused the stale-revision save to fail without
overwriting the external bytes or losing the draft. The Node desktop routes Vault and Search
only when the sidecar identifies an encrypted index and all required search operations; the
native export confirmation remains in Electron main. A packaged volatile-search run verified
that experimental search stays hidden from the desktop at 1280×900 and 900×600. The Hono probe's
encrypted index lacked queried plaintext, and exact key deletion was independently verified.
A rebuilt packaged desktop with its own encrypted-search gate advertised `search.encrypted-v1`.
Vault consent and rebuild indexed a disposable workspace file; Search returned it, and Open
preview displayed the exact file text. Excluding the source made the same query return no
matches. A prior package exposed a missing per-window file grant for search-result previews;
the rebuilt package included the fix. Both task-only Secret Service items were deleted and
independently absent after the run. Packaged export and private Codex transcript indexing
remain unverified.
An independent review found that excluded and other-window hits were filtered after the result
limit. The encrypted index now filters excluded sources in SQL, and Electron sends a bounded
source scope derived from the requesting window before querying. A reviewed AppImage indexed
two task files in separate native windows: the newer global hit did not hide the older owned
result at limit one, and the primary preview showed only its file. The source fixture was
unchanged; both task-only key items were deleted and independently absent after the run.
The Node desktop bridge also routes Text Box list/create/save/delete for the owning window.
The opt-in tools sidebar exposes Files and Text Box without advertising the unsupported full
sidebar capability. A packaged run created and edited a note, reopened it, and verified its
revision-2 content after an isolated-copy restart; a second temporary note exercised deletion.
The source fixture remained unchanged.
An explicitly enabled, process-local workspace-file search experiment exercises bounded source
consent, rebuild, query, exclusion, and summary export on isolated copies. The default server
does not advertise `search.*`: this experiment has no durable consent, Secret Service key,
encrypted index, or agent-transcript source and cannot satisfy the Vault release gate.
Shared TextBox title validation preserves Rust's whitespace and Unicode-scalar behavior.
The isolated writer now also projects the full settings shortcut catalog and handles Linux
shortcut/notification policy updates, shortcut reset, and window-scoped notification
list/publish/read state/clear. These Node mutation contracts add snapshot revision, server epoch,
and idempotency fences for safe CLI retries. The opt-in desktop demo routes notification reads
and mutations through Node; native forwarding and the default desktop path remain Rust-owned.
Rust's separate `config.json` remains a release gate: `configuration.update` validates the shell,
reconciles shortcut and notification settings with the SQLite runtime, applies logging, and
compensates the file when the runtime mutation fails. Node settings mutations alone cover only
their narrower contract. An opt-in, authenticated `configuration.qualify` read inspects a private
`config.json` beside the isolated working database. It checks file safety, Rust schema bounds,
known settings, and the shortcut/notification projection without modifying either store; its
result reports `writable: false`.
With both `AGENT_WORKSPACE_CONFIG_QUALIFICATION=1` and `AGENT_WORKSPACE_CONFIG_WRITE=1`, the
isolated Node service now exposes revision-checked configuration reads and section updates. It
preserves unknown fields, writes the owner-only file atomically, reconciles SQLite-backed
notifications and shortcuts, and compensates the file if the SQLite commit fails. Node validates
the configured shell at startup and before a write, then applies a changed shell to future
implicit terminals; existing PTYs remain unchanged. The saved logging level applies to
subsequent first-party service events in the qualified isolated copy.
A packaged desktop run
used the private API to save appearance revision 1, received HTTP 409 for a stale revision, and
read the saved value after a full app restart. The source database stayed separate. The desktop
settings bridge is qualified by the service capabilities. In the combined package, Settings
loaded the Node theme, saved a light theme at revision 2, and displayed that theme again after a
full app restart at 900×600. A later packaged run saved `/bin/bash` at revision 3, kept an
existing `/usr/bin/zsh -l` PTY, launched a new `/bin/bash -l` PTY, and restored Bash after another
full app restart. Another packaged run saved Trace at revision 4 and recorded first-party
configuration and request events in the private rotating service log.
The isolated Node service also offers a bounded, redacted healthy-state diagnostics preview and
one-use export. The approved snapshot is held in process so concurrent log writes cannot change
the exported bytes. A packaged desktop preview showed four entries at 900×600, then the native
save dialog exported a mode-0600 bundle with one redaction. Service-down recovery diagnostics
were then exercised in a packaged app by corrupting only the disposable private profile marker.
After the Node sidecar failed before readiness, Settings previewed and exported a four-entry,
mode-0600 recovery bundle with an `unavailable` classification and one redaction. The profile
marker was restored after clean shutdown. Complete Rust logging parity remains a cutover gate.
An explicit isolated-copy resume mode now checks a private manifest, immutable backup identity,
database integrity, and an exclusive Node owner file before reopening. It preserves Node writes
and rotates the idempotency epoch across a graceful server restart. It does not transfer live Rust
database ownership; crash recovery of a stale owner file remains a manual inspection step.
The unpackaged desktop probe completed a fresh launch and an explicit resume launch using a
disposable Rust-v15 fixture, with settings and notification UI interaction, verified shutdown,
owner-lock removal, and SQLite integrity. These screens still use the Rust renderer bridge.
The isolated Node CLI now lists and gets visible recently closed items and reopens a terminal tab.
Its `notify` command and Codex/Claude hook adapters publish bounded, sanitized notifications
through the Node API. A staged CLI connected to a disposable Node service, published a direct
notification and a Codex hook notice, then listed both with their expected sources and text.
The Node CLI now installs, reports, and uninstalls Codex and Claude notification hooks using
bounded, lossless edits and private state/backup files. A packaged CLI in a disposable home
installed and removed both hooks and restored each configuration byte-for-byte. A crash between
writing installer state and the user configuration remains a fail-closed conflict requiring
manual recovery.
The terminal runtime deliberately removes the Node session-file environment variable from agent
processes. The hook adapter itself has not yet been exercised by a real Codex or Claude process
from the packaged desktop.
The opt-in packaged sidecar now publishes an owner-only Node CLI discovery file in the desktop
runtime directory. The staged CLI resolves that path on Linux without a flag; a packaged run
identified the isolated service and listed two workspaces, then a clean app shutdown removed the
record and the CLI could no longer connect. This grants the same-user CLI access to the isolated
Node API; it is not a hook installer or a live database cutover.
The Node CLI also exposes direct workspace multiselection, group create/rename/delete/move/
assign/collapse, and layout save/delete/apply/import against the existing Hono contracts. The
layout import reads a bounded regular UTF-8 file and validates the Rust-compatible envelope.
CLI typecheck, build, and focused parser/dispatch checks passed; these new verbs have not been
exercised through the packaged CLI. The desktop layout bridge has separate packaged evidence
below. Other direct Rust CLI verbs still need parity.
Its bundled server proof started a live PTY before committing, sent input, observed output,
replayed the request exactly, and left the source database unchanged. Node browser navigation,
history actions, and native observations now use revision and idempotency fences in the isolated
writer; Electron main owns the native view and forwards browser changes only to windows that own
the workspace. A private inherited owner channel now holds window-bound browser provider leases
and a schema-v15 record owner stages and interrupts automation sessions and operations with exact
provider/window fences. The public browser automation routes and capability remain withheld:
an opt-in packaged probe now has a current Electron provider lease, caller ownership, and
bounded screenshot transfer, but the complete release contract still needs qualification. The
packaged probe created and destroyed an ephemeral page, navigated to a real page, read a PNG in
verified chunks, and released the screenshot handle. A rebuilt package also captured the initial
blank page immediately after creation through a bounded offscreen paint fallback. Complete
sidebar restore remains a release gate. A later packaged run used the staged CLI to navigate to
a task-owned page, query an input, type text, click Send, and query the updated status. An
in-flight selector wait then canceled and returned `canceled` from both the cancellation call
and the waiting CLI; the session still destroyed cleanly. The first cancel probe had exposed a
mailbox acknowledgement race that stopped the provider; the rebuilt package passed the same
sequence after the in-flight request was kept until its late acknowledgement. A private
inherited fd 3 channel can now issue and revoke bounded capabilities for known, nonclosing
windows through a verified
Electron sender. The isolated Node server
advertises `task.list` only with this channel, and its route requires the bearer token and a
current channel capability. A disposable fixture with an unhosted placement passed
issue, list, revoke, and denial after revoke. Electron main now derives a current window ID from
sender-bound IPC and uses the private capability for an explicitly opted-in task-list read.
That path still needs a live matching window in the same isolated copy. Node now supports bounded
remote detach and confirmation-bound terminate task actions through the same private capability;
agent and browser task actions remain Rust-owned.
A separate Linux utility can enroll an existing remote target from an inherited read-only fd 3
while the isolated Node writer is stopped. It verifies the copy, holds the exclusive owner lock,
and returned a nonsecret success after a fake-keyring fixture changed revision 2 to 3. Electron main now has an isolated-copy stop,
offline fd 3 enrollment, and resume handoff for an existing target. A real malformed key returned
`cleanup_required` and left the sidecar stopped; a controlled fake-keyring utility proved the
successful revision advance and resume path. The renderer credential flow still uses Rust.
The separately gated Node remote demo routes existing-target remote preparation, trusted-target
activation, host-key confirmation, tmux discovery, reconnect, detach, and close from an owning
desktop window. Active SSH PTYs bind to the visible terminal's projected ID, and an incomplete
binding rejects terminal input. The separately gated Node preview now offers Add Target when
the verified Node sidecar advertises online enrollment, replacement, and deletion capabilities.
Replacement and deletion controls require an existing target. Remote transport is disabled
in the ordinary Node core demo; its settings are hidden there. Isolated copies
preserve target IDs, but Node Secret Service acquisition, enrollment, and deletion now use a
private scope bound to the working database inode and a `v2-${scopeId}-${targetId}` locator.
The enrollment utility loads the same scope after copy verification and the owner lock. Focused
checks verified its separation and restart behavior. Copied Rust `v1` keys are unavailable to
Node until they are safely re-enrolled. Online new-target enrollment uses a
main-only file picker, inherited read-only fd 3, a durable Rust-v15 intent and helper-completion
marker, and atomic target publication after exact v2 Secret Service presence is verified.
Interrupted intents are cleaned before remote transport starts. Focused fake-keyring checks
covered absent marker, reused create key, and fresh commit. After KDE Wallet was unlocked, a
packaged AppImage used its native Add Target picker to enroll a task-only Ed25519 key in the exact
v2 scoped Secret Service item. Its native dialog trusted a loopback OpenSSH host key after an
independent fingerprint comparison, then connected through the broker to tmux 3.7c at
`127.0.0.1:22222`. The visible terminal echoed `remote-v15-proof`. After package resume, tmux
discovery showed `main`; after that task-only session ended it showed `No tmux sessions found`.
The UI closed the remote session and deleted its target. The target's known-hosts record and
exact v2 wallet item were removed, and an independent Secret Service `SearchItems` returned zero
matches. The Rust source database remained unchanged. This validates a task-only Linux loopback
path, not arbitrary remote hosts or a live profile cutover. Online
replacement uses a per-attempt v2 scoped backup, an activation fence, and restore on abort or
restart. The commit revokes the active transport and advances target/session revisions. Focused
fake-keyring checks passed, while no packaged live replacement occurred. Node target
deletion now has a durable deletion fence,
serialized transport and host-key cleanup, scoped keyring removal, and restart recovery. Its
authenticated route and capability appear only with scoped remote transport. The combined
packaged run advertised deletion, withheld bare target creation, and returned HTTP 404 for a
bare create request. The later loopback run exercised target deletion with a live task-only
Secret Service item.
The Linux x64 Node 22.22.3 runtime can be staged with production dependencies, a Node license,
server and CLI bundles, and a checksum manifest. The staged executable ran a real PTY and
returned its output. An opt-in Linux directory package now includes the verified Node tree and
launched with a live sidecar, Rust-backed terminal command, and clean shutdown. Default Linux
packaging excludes Node. The isolated database copy and Rust renderer are still transitional.

The packaged Linux desktop has an additional disposable-only demo gate,
`AGENT_WORKSPACE_DESKTOP_NODE_CORE_DEMO=1`, alongside the sidecar and private copy paths.
Electron main compares initial Rust and Node workspace, selection, and window IDs before
routing sender-bound workspace, group, pane, terminal, card-slot, attention, notification, and
service-owned public-action operations. Terminal output and workspace events use authenticated
Node WebSockets. The demo also routes owner-bound Files reads and text saves, Text Box CRUD, and basic browser
navigation and history through Node. A separate `window.list` read now uses the IPC sender's
current window entry and a one-use private owner capability. Electron registers and renews its
live window through a private owner channel, with a generation-specific revoke on close. A
packaged one-window read returned the copied placement and focused window ID exactly with
`hostingState: hosted`; revisions remained stable across a heartbeat interval. This validates
one hosted window; graceful shutdown persisted `unhosted` in the disposable copy. The isolated
demo now supports revision-fenced create and focus, plus rehome close when the source has no
live resources, an attached Browser view, or a local Node terminal. A packaged run opened a second native window
with its own bound workspace projection and focused the primary again. An initial package
rejected rehome with an attached Browser view; a rebuilt package staged a replacement view,
closed the secondary, and returned both workspaces to the hosted primary. The native Browser
still showed Example Domain in an X11 capture, and its DevTools target remained reachable.
A later packaged run restored a two-entry native navigation history; Back and Forward in the
primary returned to the expected URLs, and an X11 capture showed the page. History transfer
is bounded to 100 entries and 8 MiB and rejects malformed or unsafe entries. Chromium's
periodic page-state capture may miss recent form or scroll edits; live JavaScript, DOM, and
media state are not retained. Another packaged run closed a secondary window with a connected
local Node PTY. The primary
showed the same PTY PID, delayed output from a command started before close, and output from a
new command sent after rehome. A later packaged run closed a Node-created secondary window and
its disposable workspace through `closeWorkspaces`; the local PTY exited and the Rust fixture
remained separate. The retained terminal history cannot reopen once its workspace root is gone.
Node-created window provenance now has a copy-local durable table because ordinary idempotency
result pruning could otherwise remove the only creation proof. A focused regression pruned the
create result, restarted the service, then closed that Node window while denying a Rust-base
window close. A reviewed AppImage also created and closed a Node secondary, leaving no live
provenance record. A preview window whose creation result was already pruned before this fix
cannot recover that proof automatically.
Remote terminal transfer, Rust-base window deletion, resume after deleting a Rust base ID, and
broad multi-window command exposure remain closed.
The packaged secondary window then closed its Browser tab through the sender-bound Node route;
the native view disappeared, its terminal ran a shell command, and its sidebar retained only the
owned workspace after a delayed refresh. Renderer mutation and browser responses now use bound
workspace projections so in-flight updates cannot add a sibling window's workspace.
Packaged resume now reopened the same two persisted window IDs as hosted and ran a terminal
command in the recovered secondary window. The disposable Rust database retained only its one
base placement and window-state row. The resume gate requires every Rust base workspace/window
ID to remain in the Node copy; deleting a base ID fails closed pending stronger reconciliation.
Rust remains the default. The demo still rejects
unsupported content, agent, and window mutations, and does not forward Rust domain events. It is
not a live data cutover.
Its renderer identity withholds Rust capabilities for agent sessions, browser automation,
multi-window operations, saved layouts, and full sidebar surfaces until their Node paths are
ready. Configuration writes appear only with the separately qualified private config copy;
remote sessions are shown only under the separate remote demo gate.
A packaged disposable fixture run created a third workspace, used its live Node PTY, pinned
an existing workspace through a Node action, created a group, replaced a v1 card slot, and
acknowledged a notification through Node attention. The source copy stayed at two workspaces
while the Node working copy had three. A later packaged disposable run also created a group,
replaced a v2 Markdown card, observed its renderer update, marked a notification read in the
dialog, observed the workspace attention badge clear, and ran a command in the Node PTY at
1280×900 and 900×600. The Node working copy recorded the read; the separate Rust profile did
not. Another packaged disposable run navigated a native browser view to a real page, navigated
to a second URL, and returned through Back with the toolbar reflecting the observed URL. It
shut down cleanly. The gated remote tmux loopback path has packaged proof, but agent sessions,
complete browser automation, remaining Rust-backed reads, and live state ownership still need
qualification before cutover.
The packaged Node PTY exposed a renderer input-order race under rapid typing: independent
character IPC calls could reach the shell out of order. The renderer now serializes input per
mounted terminal and drains it before detach. A focused ordering check and a rebuilt packaged
Electron run both passed; the typed `echo node-input-order-ok` command returned its expected
output at 900×600 and 1280×900.
The isolated desktop bridge now routes pane split, close, and tab moves to Node. A packaged
AppImage split the selected terminal, moved a tab between panes, closed a pane, then reopened a
split and displayed `node-pane-v18-proof` from its new live PTY at 1280×900. Closing a pane
exposed a late renderer checkpoint after the server had removed its terminal. The bridge now
accepts that late checkpoint only for the exact closing window and terminal, for at most 30
seconds, while rejecting other-window access. A rebuilt AppImage closed the pane at 900×600
without the prior handler error, exited zero, and removed its private Node CLI record. The
disposable source database remained unchanged. Saved-layout public exposure remained gated by
resource reconciliation and complete UI flows.
The packaged AppImage also completed an ephemeral browser automation create, navigate, and destroy
through its packaged CLI and Electron provider. The public capability remains gated pending
attached-tab approval, provider-loss, and full create/dispose lifecycle qualification.

The subsequent v20 packaged desktop exercised a UI tab rename and terminal command, then saved
and restored sidebar placement in its isolated copy. The Node bridge now routes tab updates and
sidebar placement reads/writes; native sidebar width is clamped to its supported range. The
layout bridge now has list/get/save/delete/apply/import/export operations. The saved-layout UI
capability remains hidden pending remote, agent, browser, and multi-window resource parity and
complete UI flows. Layout apply is restricted to the sole hosted
target: it rejects removed workspaces, fences agent and remote bindings, and validates terminal
paths. These constraints do not establish general multi-window layout parity.

The v21 AppImage passed the packaged Node inspector. A first fresh-copy attempt exposed that
the Node demo copy must retain the initial Rust workspace and window IDs. A rerun with a matched,
task-only Rust fixture (workspace root and terminal cwd both `/tmp`) saved a layout at revision 2,
renamed the tab through the UI to a custom title at revision 3, then applied the layout through
the bridge and restored the null custom title at revision 4. A terminal command worked. After
restart with `COPY_RESUME=1`, the UI displayed `shell` and the saved layout still existed. The
source fixture remained 368640 bytes with unchanged mtime. Shutdown exited zero without a
metadata-handler error. An earlier legacy fixture correctly rejected layout apply with
`unauthorized_layout_path` because its terminal cwd was outside its workspace root.

The v22 AppImage passed the packaged Node inspector after bounded replay/event handling and a
backend catalog-binding guard were added. On a matched, task-only Rust fixture with
`COPY_RESUME=1`, a UI rename set the tab custom title to `node-v22-changed` at application
revision 9. Direct renderer-bridge apply of the saved layout restored a null custom title at
revision 10; the visible selected tab label changed to `shell` within 500 ms, without restart.
Retrying with the same idempotency key returned revision 10, left state at revision 10, and kept
`shell` visible. The bridge now emits a sender-bound `workspace.changed` after native
reconciliation and keeps a 64-entry, 10-minute exact-request cache for replay recovery;
completed entries may be evicted. The backend validates each bound tab's terminal kind and
launch both before and during the transaction commit. A terminal ran
`echo node-v22-layout-event-ok`, with output visible at 900×600 and 1280×900; both screenshots
were inspected. The source fixture SQLite file remained 368640 bytes with unchanged mtime 1790350227. Targeted shutdown exited zero without a handler error and left no private CLI
record or owner lock.

The v24 AppImage passed the packaged Node inspector with a window-bound Recently Closed
list/reopen bridge. The first v23 run exposed a missing desktop identity advertisement; the
renderer now receives `recentlyClosed.list` and `.reopen` only when the verified Node sidecar
supplies both. On the matched disposable copy, the v24 UI listed a terminal closed in the
previous run, reopened it into the selected pane, and ran `echo node-v24-reopen-ok` in the
restored PTY. Inspected 900×600 and 1280×900 screenshots showed the command output and the
cleared Recently Closed list. Closing that tab again and pressing Refresh listed it; reopening
cleared the list a second time. An exact lost-response retry returns the durable result before
the short-lived descriptor expires, with current window binding still required. A focused
Rust-v15 fixture confirmed replay starts no second PTY. The source fixture remained 368640
bytes with unchanged mtime 1790350227; targeted shutdown exited zero. The fixture's `/tmp`
workspace is root-owned, so Files root listing correctly returned `unauthorized`; Files was
not qualified by this run. In a second v24 packaged run, the UI created an Example Domain
Browser tab, closed it, listed its `reopenBrowser` record, and reopened it. The selected
Browser tab again had `https://example.com/`, the native BrowserView showed the page in an
inspected X11 window capture, and Recently Closed became empty. Full sidebar parity remains
unverified.

The v25 AppImage adds bounded provider recovery after startup or provider loss and tears down
the exact browser automation lease when Node window hosting stops. Source review found and
prompted the hosting-stop fix; server revocation is identity-fenced, so delayed cleanup cannot
revoke a replacement lease. It also adds a separately gated Node Task Manager list and a
sender-bound remote detach path. The packaged desktop returned an empty Node task list for the
matched fixture, while the packaged provider created and destroyed an ephemeral browser
automation session. Its public browser automation capability remained hidden. An inspected
native X11 capture showed the retained Example Domain Browser view. The source fixture stayed
368640 bytes with mtime 1790350227, and app shutdown exited zero. No live SSH/tmux task was
available for a provider-backed detach check; destructive task actions and the Node Task
Manager UI remain gated. Recovery after an injected provider failure was not exercised in the
packaged app.

The v27 AppImage includes the Node Task Manager list UI behind its separate capability gate.
In a matched disposable copy, the packaged desktop displayed its empty task list and refreshed
it. A native BrowserView covered the tools overlay at 900×600; the renderer now clips native
browser bounds to the visible pane when the tools sidebar overlays it. Inspected native X11
captures at 900×600 and 1280×900 show the Browser page and readable Task Manager together.
The packaged Node runtime inspector passed, the source fixture remained 368640 bytes with
mtime 1790350227, and targeted shutdown exited zero. A read-only
[cutover preflight](../node-cutover-preflight.md) now reports source identity, revision, digests,
external-state presence, and explicit ownership blockers without transferring live data.
New isolated copies record main/WAL and logical SQLite digests in a version 3 manifest; copy
preparation and preflight compare the backup's complete logical contents with the observed
source. A Rust schema fixture proved that a write to another table with unchanged snapshot
revision or a changed hidden row ID rejects a stale backup. Version 1 and 2 preview copies
remain resumable but cannot
pass the full binding check. Preflight also inventories the actual Rust desktop settings path
at `userData/configuration/desktop.json`; external settings migration remains a release gate.
The private Node owner channel now supplies provider and window-generation authority for
agent hibernation. Hono and the client runtime expose preflight, cancel, and confirm only
when that authority exists. Electron routes the existing warning dialog through the Node
catalog and current Node provider lease for a hosted window; the Node service checks the
exact live PTY before termination. Focused authority, HTTP, and desktop tests passed.
The packaged v28 AppImage passed runtime inspection, resumed an older isolated copy,
displayed Task Manager beside a Browser at 900×600 and 1280×900, refreshed its empty task
list, and echoed `v28-node-terminal-ok` in a Node terminal. Its source fixture kept the same
size and mtime. No live agent was hibernated in the package, so the destructive dialog and
process disposition still lack packaged proof. Shutdown exited zero but logged a terminal
attach request racing the stopped sidecar under terminal Ctrl+C, which also signals the
child process. The Node sidecar now drains in-flight attaches before terminating the child.
The inspected v29 AppImage echoed `v29-shutdown-proof` in a live Node PTY; using the
desktop Quit action then completed all shutdown stages with no attach error and exit code 0.

At the time of the v29 isolated-copy observation, production cutover still required live data ownership transfer and live agent-profile migration;
public attached browser automation and provider-loss recovery proof; remote, agent, browser,
and multi-window resource parity plus complete saved-layout UI flows; frontend mutation and
capability parity for the remaining sidebar surfaces and task actions, including closed-workspace
Recently Closed behavior; provider-backed remote detach; and a manual Ubuntu AppImage/deb/rpm
workflow run. These packaged, isolated-copy results do not make the Node
backend production-ready. The current Linux desktop starts Node for fresh profiles; the
existing-profile migration and release gates remain open.

## Consequences

- The Rust source/build tree has been removed. The TypeScript protocol client retains validated
  wire contracts and compatibility fixtures. Existing-profile migration must be qualified
  independently before release claims cover those profiles.
- Terminal and database native dependencies need exact Electron/Node runtime packaging and tests
  on every platform supported by the release before support claims.
- The Node API can evolve behind shared contracts, but any frontend switch requires real-app
  interaction checks and visual evidence at relevant viewports.

## Alternatives considered

- Effect was considered for similarity with T3 Code's server. The product owner chose Hono and
  plain TypeScript for a smaller backend they can maintain directly.
- A Node proxy that leaves feature ownership in Rust was rejected as a final architecture because
  it does not remove the Rust maintenance requirement.
- A core-workspace-only first release was rejected because the product owner requires full parity.

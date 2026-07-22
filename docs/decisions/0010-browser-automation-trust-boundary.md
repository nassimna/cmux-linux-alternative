# 0010: Browser automation trust boundary

**Status:** Accepted

## Context

M5 adds addressable navigation, DOM interaction, and screenshot automation. Existing remote pages run
in locked, sandboxed `WebContentsView` instances owned by Electron main, with popup, navigation,
permission, download, and external-URL policy. Exposing renderer IPC, generic JavaScript evaluation,
DevTools/CDP, caller-selected partitions, or raw `webContents` IDs would cross that boundary and
could reveal desktop capabilities or another profile's data.

M5 depends on an accepted automation threat model and the durable action/provider state machine in
ADR 0008.

## Decision

### Identity and authority

The service advertises optional `browser-automation-v1` and owns addressable, bounded automation
session and operation records. Electron main alone executes native browser effects through the
reverse desktop-provider path. Renderer and preload expose no automation primitive.

An automation session binds immutable opaque service identities and generations for automation
session, browser session, browser lifecycle, workspace/pane/tab, provider lease, window, and
partition ownership. Raw Electron `webContents` IDs and caller-selected partition names never cross
the public contract. Main revalidates the complete binding against a fresh authoritative snapshot
before every native dispatch and acknowledgement.

Attachment to an existing user browser session requires an explicit exact target and trusted
desktop confirmation. Otherwise automation creates a unique, automation-owned, nonpersistent
partition with a fixed namespace. It never shares cookies, cache, permissions, storage, or download
state with another browser or profile. Session destruction clears grants and ephemeral storage to
the extent Electron supports, then destroys the owned view.

Electron main also becomes the runtime owner for the existing stored browser profile/privacy
configuration. It maps each enabled profile to an isolated approved partition, applies privacy and
permission policy before view creation, and rejects unavailable or unsafe combinations. Automation
creation uses the selected policy in a stricter ephemeral partition; attachment cannot weaken that
profile's privacy controls. `browser-automation-v1` is withheld until these formerly disabled
controls are applied truthfully and covered by isolation and permission evidence.

### Closed operation set

Version 1 permits only typed:

- safe HTTP/HTTPS navigation;
- bounded wait for lifecycle or one validated selector condition;
- selector query returning a bounded text-free structural summary;
- focus, click, literal text input, and a closed key enum; and
- bounded screenshot capture.

There is no public generic JavaScript evaluation, DevTools/CDP passthrough, arbitrary network
interception, cookie/storage export, HTML/DOM dump, file read/write, permission grant, download-path
selection, popup, external open, or devtools operation. If fixed internal scripts are required for a
typed DOM primitive, main selects the script and returns only its strict minimal schema; callers
cannot supply code or script fragments.

Selectors, text, result counts, screenshot dimensions/bytes, redirects, navigation count, operation
queue, concurrent operations, session count, operation timeout, session TTL, and retained terminal
results have hard protocol and runtime bounds. Typed text, selector results, DOM content, screenshot
bytes, private URLs, cookies, and credentials are never logged, audited, persisted, or included in
diagnostics. Screenshots remain bounded in memory and use one-time retrieval; callers must
explicitly save them through an authorized action if that is later supported.

The concrete v1 limits are 8 live sessions per provider and 16 per profile, 32 queued operations per
session, and one executing DOM/input operation per session. Selectors are at most 1,024 scalars,
typed text 48 KiB of UTF-8, and URLs 2,048 scalars; the complete serialized invocation must remain
within the 64 KiB `actions-v1` parameter cap. A query returns at most 100 matches and 16 KiB of structural
data. Screenshots are at most 4,096 by 4,096 pixels, 16 million pixels, and 16 MiB encoded. A session
allows 20 redirects per navigation and 100 top-level navigations. Operations default to 30 seconds
and cap at 120 seconds; sessions expire after 30 minutes of inactivity. Ephemeral content results
expire after 60 seconds; at most 4,096 content-free terminal records remain for 24 hours. Limit
overflow rejects the new operation with `resource_limit`; queue/session expiry cancels and fences all
pending work before view cleanup.

Screenshot capture returns only an opaque caller-scoped handle, dimensions, byte length, media type,
SHA-256 digest, chunk count, and 60-second expiry inside the action result. Bytes remain in main-owned
bounded memory. At most two handles/32 MiB per automation session, eight handles/64 MiB per provider,
and 16 handles/128 MiB per profile may be retained. A capture that would exceed any budget fails
`resource_limit` without evicting a readable handle; release or expiry frees its exact budget.

A fixed `browser.automation.screenshot.read` content-transfer command retrieves an indexed sequence
of at most 32 base64 chunks, each at most 512 KiB before encoding so the complete response remains
under the 1 MiB frame cap. This command is capability-gated and outside the generic `actions-v1`
parameter/result envelope and its 64 KiB result cap; it retains the action provider's exact caller,
window, browser, session, generation, cancellation, and authorization fencing. Each
`(handle, chunkIndex)` read is idempotent until expiry; a caller
verifies sequence/count/digest and sends typed release, which zeroizes/removes all chunks. Reads use a
per-caller queue of four with response priority; overflow returns `automation_backpressure` without
dropping retained chunks. Cancel, session destroy, caller/provider loss, or expiry fences reads and
removes the handle. Handles cannot be transferred, listed, or reopened after release/expiry.

### Epochs, cancellation, and policy inheritance

Every operation carries the current automation session generation, navigation epoch, operation ID,
and attempt epoch. Top-level navigation, redirect, renderer crash, view destruction, browser
lifecycle replacement, ownership transfer, provider/window generation change, or session destroy
invalidates queued DOM/input/wait results. A stale callback returns `stale_navigation` or the already
persisted terminal result; it never applies to a newly loaded page.

Operations are registered in a cancellable main-owned pending set before execution. Explicit cancel,
timeout, session destroy, provider loss/expiry, target window close, and service shutdown fence all
late completions. Destruction cancels waits, timers, capture, navigation continuations, dialogs, and
downloads; removes handlers/grants; destroys automation-created views; and returns the manager's
live view/handler counts to baseline. Cleanup is idempotent.

Automation inherits and cannot relax all existing safe-URL, popup, navigation/redirect, permission,
download, external-URL, isolation, sandbox, and no-preload policies. Navigation epochs are checked
again after asynchronous confirmation or save-dialog completion. `capturePage` cannot bypass target
identity or content privacy policy.

### Provider, idempotency, and contracts

Automation session creation/destruction and each operation use `actions-v1` provider registration,
lease, exact target arbitration, cancellation, and first-terminal-result rules. Side-effecting
operations durably replay their terminal status under the action idempotency epoch. Privacy-sensitive
query and screenshot bytes remain ephemeral: persistence stores only terminal status and a digest.
If their response is lost or the service restarts, retry returns `result_expired` and never re-executes
the page operation; exact content replay is intentionally not promised.
Selectors, typed text, private URLs, and other sensitive operation parameters are likewise retained
only in the bounded in-memory dispatch record. The durable invocation contains operation kind,
identities/epochs, byte counts, and a keyed request digest—not the parameters. Restart or provider
loss before a terminal acknowledgement reconciles such an invocation to `interrupted`; retry returns
that outcome or `result_expired` and never redispatches from missing sensitive input.
Retry never selects another provider, window, browser session, or attempt for the same native effect.
Provider disconnect, lease expiry, window close, and multi-window transfer yield one explicit
terminal outcome and reject duplicate or late acknowledgements.

Rust DTOs are canonical and generated TypeScript/Zod rejects unknown fields, `null` ambiguity,
invalid IDs/epochs, unsafe URLs, unbounded selectors/text/results/images, and unsupported operations.
CLI adds versioned `browser automation` JSON commands but cannot bypass desktop confirmation or
target authorization. Older services remain usable with automation commands/UI absent.

## Consequences

- Hostile pages gain no Node, Electron, preload, desktop bridge, control token, or generic code
  execution surface.
- Automation cannot address another profile, partition, window, or browser by raw native identity.
- Navigation and destruction races are fenced by exact generations and epochs.
- Existing popup, permission, download, redirect, and external-URL protections remain mandatory.
- Protocol/property, fake-Electron lifecycle/race, hostile-page E2E, screenshot/privacy, leak-count,
  provider-disconnect, multi-window routing, packaged smoke, and console/network evidence are
  required before M5 qualification.

## Alternatives considered

- Renderer/preload automation was rejected because remote content and renderer compromise must not
  reach native browser control.
- Generic `executeJavaScript` or CDP was rejected because it would defeat the closed operation set
  and enable DOM/credential exfiltration.
- Reusing caller-selected persistent partitions was rejected because a partition is a profile data
  boundary, not a convenience string.
- Persisting screenshots or DOM results by default was rejected because they can contain sensitive
  user content.
- Best-effort cancellation without epochs was rejected because late callbacks could act on a new
  navigation or owner.

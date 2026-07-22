# Performance qualification

This suite produces release-build evidence, not development-build estimates. Its JSON report is
the durable artifact; terminal output is only a progress log.

## Reference environment

Record the machine before interpreting or approving a result:

```sh
uname -a
lscpu
free -h
lsblk
cat /etc/os-release
```

The report records OS/kernel, architecture, logical CPU count, hostname, Node version, CI status,
and `releaseBuild: true`. For comparable baselines, also record display server, compositor, GPU,
power profile, whether the system is on AC power, and whether unrelated workloads were running.

## Modes and commands

From the repository root:

```sh
pnpm --filter @agent-workspace/desktop test:performance:helpers
pnpm --filter @agent-workspace/desktop performance:smoke -- --output /tmp/agent-workspace-performance-smoke.json
pnpm --filter @agent-workspace/desktop performance:soak -- --output /tmp/agent-workspace-performance-soak.json
pnpm --silent --filter @agent-workspace/desktop performance:analyze-soak -- /tmp/agent-workspace-performance-soak.json > /tmp/agent-workspace-performance-soak-analysis.json
```

Run the two soak commands above from an unchanged final-code release-candidate checkout. The first
command is intentionally non-resumable and runs for exactly eight hours; allow it to exit
successfully and retain the resulting JSON before running the analyzer. Review both artifacts and
the complete chronological series before changing the soak rows in
[the release qualification record](RELEASE_QUALIFICATION.md) from `NOT RUN`. Until that report and
manual trend review exist, the build remains a release candidate even if the implementation
milestone is otherwise complete.

Both modes build the Rust service and CLI with `--release`, build the unpacked packaged Electron
application, run the release-service PTY benchmark, and launch the packaged application. The
packaged suite includes a five-minute quiet settle followed by a five-minute idle CPU measurement.
Linux procfs and an X11 or Wayland display are required.

The latest local packaged smoke on 2026-07-21 passed every required metric. Its five-minute idle
window averaged 0.8893% process-tree CPU after a five-minute quiet settle, against the strict
`< 1%` gate. One-terminal and ten-terminal application PSS passed at 347.04 MiB and 371.98 MiB.
The machine-readable report is retained at
[`validation/evidence/performance/2026-07-21-smoke-candidate.json`](validation/evidence/performance/2026-07-21-smoke-candidate.json).
This host-specific smoke evidence does not establish the still-unrun exact eight-hour soak or a
maintained cross-host baseline. The earlier failed diagnostic is retained separately as the pre-fix
comparison.

### Deferred 2026-07-18 soak attempt

The local `v27` attempt began at 2026-07-18 18:31:48 CET and was deliberately stopped at
approximately 21:39:26 CET after about 3 hours 8 minutes under the implementation-task validation
policy. It exited through `SIGTERM`, produced no JSON report, and therefore provides no duration,
sample-count, memory-trend, or stability qualification. Its status is **deferred, not passed**. The
partial progress log is retained locally with mode `0600` at
`/home/nassimna/.local/state/agent-workspace/validation/2026-07-18-soak-v27-partial.log`; its SHA-256
is `878f3e79046659f5b68285962add22537fac23ce84fd5317ef3ffe0980d0bf9b`. That log is diagnostic
evidence only and must never be supplied to the report analyzer or cited as a completed soak.

`smoke` is short qualification evidence. It writes `fullSoak: false` and explicitly records that
the 8-hour scenario did not run. `soak` is opt-in and has a hard-coded duration of exactly eight
hours; it cannot be shortened with an environment variable. It writes 481 aligned chronological
elapsed-time, PSS, aggregate RSS, and private-memory samples on absolute monotonic one-minute
boundaries, with an output heartbeat at every observation. The executable report validator rejects
a soak report unless its wall-clock timestamps span at least eight hours, all four series contain
exactly 481 samples, the final monotonic sample reaches the eight-hour boundary, and the timeline
retains its cadence without duplicates or missing intervals. A completed smoke run must never be
described as an 8-hour-soak pass.

To compare against a maintainer-approved result:

```sh
pnpm --filter @agent-workspace/desktop performance:smoke -- --baseline ./approved-host-baseline.json
```

A p95 deterioration greater than 15% exits nonzero and requires investigation. Metrics whose
higher value is better, such as frames per second, are compared in the opposite direction. The
checked-in `apps/desktop/scripts/performance/baseline.schema.json` intentionally contains no values.
A candidate can be copied for review with `--capture-baseline ./candidate.json`; that does not make
it approved. The JSON schema is a portable structural envelope; the executable `validateReport`
checks the stricter cross-field invariants, recomputes every metric summary and pass result, and is
authoritative for qualification.

## Definitions and gates

Percentiles use the nearest-rank definition over sorted measured samples. PTY responsiveness uses
10 unreported warmups and 40 measured samples. Application memory is aggregate proportional set
size (PSS) for the packaged Electron root and all descendants discovered only through
`/proc/*/status` parent-PID traversal. Each descendant's `Pss`, `Private_Clean`, and
`Private_Dirty` fields are read strictly from `/proc/<pid>/smaps_rollup`; summed `VmRSS` remains a
separate diagnostic and is never relabeled as application PSS. PSS is the primary gate because it
divides shared Electron mappings proportionally among the processes that map them, avoiding the
systematic double counting in a process-tree RSS sum. Private memory is reported as
`Private_Clean + Private_Dirty`. These are application-process measurements, not JavaScript heap
measurements.

Idle CPU uses the packaged Electron root plus descendants identified from strict
`/proc/<pid>/stat` parent relationships. Process identity is PID plus kernel start time, so PID reuse
cannot be mistaken for one continuing process. Per-process user and system jiffies are divided by
the matching aggregate `/proc/stat` delta and multiplied by the online CPU count. This yields the
usual percentage of one CPU without assuming a kernel `CLK_TCK` value. Descendant disappearance
invalidates the entire required measurement rather than undercounting an exited process. The
packaged suite permits one completely fresh five-minute retry after such an invalidation and records
the retry count; a second topology change fails qualification. Newly observed descendants are
counted conservatively from their complete current CPU total.

PSS is still a point-in-time kernel accounting estimate: sharing proportions, allocator state, and
resident pages can change between observations, and comparing hosts requires equivalent kernels
and permission to read `smaps_rollup`. The smoke suite waits for each terminal scenario to settle,
then records three timestamped observations; nearest-rank p95 is therefore the maximum of those
three values. Cold interactive time begins immediately before process launch and ends when a
terminal pane has a real process ID. Warm restored-visible uses the same persisted profile after a
complete process stop.

The high-output scenario first proves the selected shell is responsive, then sends 20,000 numbered
lines and requires its unique completion marker. Live chunks are used when available; if the
bounded service event queue requests resynchronization, the measurement follows the production
contract and looks for the marker in an authoritative attach checkpoint/journal. The report records
the resync count, and a terminal exit or marker-less final snapshot still fails the scenario.

| Metric                    | Specification target | Suite treatment                                                    |
| ------------------------- | -------------------: | ------------------------------------------------------------------ |
| PTY dispatch p95          |             <= 10 ms | Required gate, release service                                     |
| Perceived echo p95        |             <= 50 ms | Required gate, release service and real PTY child                  |
| PTY resize dispatch p95   |             <= 10 ms | Required gate, release service                                     |
| Cold interactive p95      |              < 2.5 s | Informational; three compositor-sensitive samples                  |
| Warm restored visible p95 |              < 1.5 s | Informational; three compositor-sensitive samples                  |
| Split resize              |            >= 50 fps | Informational; real paced mutations, shared-runner noise applies   |
| One terminal PSS          |           <= 350 MiB | Required gate; three settled observations                          |
| Ten terminal PSS          |           <= 700 MiB | Required gate; three settled observations                          |
| One/ten/30 terminal RSS   |              no gate | Informational summed `VmRSS` diagnostic                            |
| One/ten/30 private memory |              no gate | Informational `Private_Clean + Private_Dirty` diagnostic           |
| Idle CPU                  |                 < 1% | Required five-minute process-tree average after five-minute settle |
| Eight-hour memory         |  no unbounded growth | Full-soak time series for manual trend review                      |

The exact application-memory specification values remain required gates in JSON; a miss is a
qualification failure and the threshold must not be weakened. Launch and split-resize targets stay
informational when compositor scheduling, filesystem cache, or VM contention would make a short
shared-runner result flaky. Any required-gate failure exits nonzero.

## Covered load scenarios

The smoke run measures rapid PTY input/echo, a five-minute packaged idle CPU window after a
five-minute settle, 20,000 lines of terminal output, repeated split resize, one/ten/30-terminal PSS,
RSS, and private memory, 30-terminal teardown, five native browser view lifecycle cycles, and 100
notifications submitted through the packaged CLI. The full soak adds continuous output heartbeats
and aligned PSS/RSS/private-memory sampling for eight hours.

## Unproven and manual items

- The idle CPU gate retains the whole-window average and chronological approximately one-second
  interval samples in JSON. Host-level noise does not directly add to the application jiffies, but
  power profile, compositor, GPU, and display-server differences still make cross-host comparison a
  release qualification concern.
- A structurally valid 8-hour report proves duration, cadence, sample count, and series alignment;
  it does not prove bounded growth. The `performance:analyze-soak` helper validates the source again
  and emits deterministic descriptive PSS/RSS/private-memory evidence: first/last values, extrema,
  whole-run and late-two-hour linear slopes, and first-/final-hour mean change. It deliberately emits
  no automatic verdict or threshold. A maintainer must review the chronological source and analysis
  for sustained late-run growth, OOM kills, renderer/service restarts, and host comparability. A
  smoke report is rejected and contains no evidence for this claim.
- Launch thresholds require an agreed reference machine and a larger maintained sample set before
  promotion from informational to normative gates.
- Visual smoothness, input feel under compositor load, and behavior across GPU/display-server
  combinations remain manual qualifications.

Do not publish a passing claim if the JSON is missing, schema validation failed, `releaseBuild` is
not true, a required metric failed, or the scenario being claimed is listed as not run.

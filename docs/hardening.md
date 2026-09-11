# Hardening and recovery

The tested v0.1 platform scope is macOS arm64 locally and Linux on GitHub-hosted
CI. Windows is not yet a verified platform. Large-repository samples below are
acceptance probes, not production latency or peak-memory guarantees.

## File failures

Recoverable source access failures (`EACCES`, `EPERM`, `ENOENT`, `NOT_FOUND`,
`EIO`, `EBUSY`) produce an `INDEX_ERROR` file with a sanitized error code. Healthy
sources can still publish. Failed files contribute no symbols and make the
result incomplete. Each subsequent index scans and retries the file; successful
reading changes its status/hash and triggers semantic re-analysis even without
a content edit. Directory discovery and configuration failures still abort the
attempt because silently omitting them could corrupt dependency resolution.
Fatal parser/database failures retain the last completed graph.

## Durable attempt status

Migration 4 adds one latest-attempt record per project. `status`, MCP
`codebase_status` and `doctor` expose `lastIndexJob` with SCANNING, ANALYZING,
PUBLISHING or COMPLETE, state, timestamps and session identity. FAILED records
include a bounded error code; detailed source contents and exception text are
not copied into these records. `fileErrors` includes at most 20 affected paths.

A RUNNING record whose owning backend no longer holds the exact project
advisory lock is reported with `interrupted: true`. Run `index --project ...`
to reconcile it; no delete, forced unlock or automatic destructive repair is
necessary. A surviving process holds its lock until publication/cleanup ends.
Connection loss releases the pool slot and permits a later retry. A process
killed with SIGKILL cannot finalize its status, which is why lock ownership is
checked rather than trusting timestamps alone.

Progress is operational metadata, separate from atomic graph publication. A
crash between publication and the COMPLETE update can leave a completed graph
and an interrupted attempt together. The next no-op reconciliation resolves the
marker. This is a latest-attempt record, not an unbounded job history or a daemon.

## Cost of unchanged indexing

Index reconciliation reads a file manifest (path, hash, status and generation),
not a complete symbol/edge/content snapshot. Source files are still scanned and
hashed to detect missed watcher events. An unchanged run skips parsing and graph
writes but updates its lightweight operational progress record. Changed source
still conservatively re-analyzes the selected project to preserve call targets.

## Evidence

`tests/integration/recovery.test.ts` exercises recoverable file reads, failed
parser attempts, abandoned progress, an actively held database connection being
terminated, and subsequent retries. `tests/e2e/mcp.test.ts` kills a separate Bun
lock-owning process with SIGKILL and verifies that CLI reconciliation retains
the graph. Existing tests cover cycles, ambiguity, size limits, broken syntax,
missing configs, watcher reconciliation and normal EOF/signal shutdown.

To probe an explicitly selected real project without altering its sources or
existing index, use a disposable database:

```sh
bun scripts/verify-project.ts /absolute/project createSourceFile
# Optional maximum source-file size, up to 16 MiB:
bun scripts/verify-project.ts /absolute/project createSourceFile 16777216
```

The script reports scope checks, graph counts, unresolved/diagnostic counts,
no-op behavior, query latency and parent-process RSS at the end. It checks edge
integrity and removes its temporary database afterward. RSS at the end is not
peak memory or total parser-worker memory. The command needs CREATEDB permission,
like the test suite. See verification.md for recorded samples and their limits.

## Offline parser acceptance and worker failures

When database operations are unavailable, run:

```sh
bun run verify:parser /absolute/project
```

This scans and analyzes the selected sources without executing project code,
building it, connecting to PostgreSQL or publishing an index. It reports parser
wall time separately from scanning and integrity validation, plus duplicate IDs,
dangling edges and foreign file ownership. Unresolved targets and diagnostics are
counts, not an exhaustive semantic correctness guarantee. This does not verify SQL
queries, index publication or incremental reconciliation. The successful JSON report omits source
contents, paths and symbol names so aggregate results can be reviewed separately.

The parser subprocess defaults to a 120-second deadline and has a 256 MiB output cap.
Timeout, output-cap, startup, input-stream, unsuccessful-exit and invalid-JSON
failures now have distinct messages. Failure clears buffered output and the timer
and sends SIGKILL to the isolated parser, so it cannot outlive the failed attempt.
Worker stderr is not included in error messages. Unit tests exercise each failure
and successful completion. Large projects can still exceed these limits; this
release keeps the default deadline unchanged. The validated `parserTimeoutMs`
project option allows 1000–600000 ms. For an offline probe, override it without
writing the selected project: `bun run verify:parser /absolute/project 300000`.
A longer budget is not a parser speed improvement.

## Locating parser costs

`bun run profile:parser /absolute/project` reports newline-delimited JSON for
scanner, workspace, declarations, compiler program creation, checker preparation,
per-file semantic analysis, deduplication and total analysis time. The optional
second argument stops after that many semantic files, for example:

```sh
bun run profile:parser /absolute/project 1000 > /tmp/parser-profile.jsonl
```

A `STOPPED` record explicitly means incomplete analysis. The limit is a file
budget, not a time or memory bound; discovery/declarations/program creation still
precede it. This diagnostic runs in-process and does not publish an index, access
PostgreSQL or execute the selected project's code. Use `verify:parser` for the
isolated worker's deadline and output-cap acceptance instead. Profiles include
relative filenames; keep raw private-project profiles local. `heapUsedBytes` is
a sampled JS heap metric, not total or peak process memory.

The profiling callback is optional. Normal parsing does not emit profiles or
sample the clock per AST node. Tests compare profiling and non-profiling graphs.

## Bounded watcher endurance

`tests/integration/watch-endurance.test.ts` runs 12 source-change bursts in a
synthetic repository, including transient create/rename/delete operations. Three
injected parser failures must preserve the complete last graph and recover via
periodic reconciliation without another source edit. Four session restarts must
index files created while closed and remove them after deletion. Every settled
round checks the final function identity and edge endpoints; final indexing must
be a no-op. A separate gated parser test holds an analysis open until a later
write is queued, then checks convergence with periodic reconciliation set to one
hour.

These tests use real filesystem watching and a disposable CodeMemory database.
They are bounded correctness regressions, not a multi-hour soak test or memory
leak acceptance. Long-duration operation and peak-memory measurements remain open.

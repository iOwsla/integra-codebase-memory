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

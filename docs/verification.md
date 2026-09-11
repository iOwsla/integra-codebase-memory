# Verification evidence

Recorded on 2026-09-11. See the development tracker for release scope.

- Dependency installation with Bun succeeded; versions are locked in bun.lock.
- PostgreSQL + pgvector Compose service started healthy.
- Tests create fresh randomly named databases and apply migrations; test databases are removed afterward.
- Phase 9 hardening increment local checks passed: `bun run lint`, `bun run typecheck`, `bun run test` (62 tests across 11 files), and `bun run build`.
- Test split: 30 unit, 24 PostgreSQL integration, 8 real CLI/MCP E2E.
- Parser coverage includes workspace exports/conditions, referenced custom configs, declaration output redirects, ignored/outside configuration boundaries, overloads, accessors, CommonJS and shadowed module globals. See `parser.md` for the supported scope and limits.
- Compiled Bun entry `bun dist/index.js --help` ran successfully.
- SDK v2 client E2E exercises tool listing, scoped structured symbol search, callers and rejection of repository ID injection.
- Raw Bun processes verify EOF, SIGINT and SIGTERM shutdown, watcher stop and subsequent advisory lock acquisition.
- PostgreSQL row `xmin` values verify that no-op indexing does not rewrite symbols or edges.
- Graph publication with invalid foreign-key targets rolls back and preserves the completed graph.

## Synthetic performance sample

1,000 small TypeScript files, local Docker PostgreSQL, Bun, one run:

| Measurement | Result |
| --- | ---: |
| Initial scan/parse/publish | 713 ms |
| No-op scan/hash check | 235 ms |
| Symbol query including snapshot load | 45 ms |
| Process RSS at end | 115 MB |

These small synthetic fixtures do not establish production performance for 10,000 complex files or 100,000 symbols. Run `bun run benchmark 1000` to reproduce the measurement procedure.

## Real repository smoke test

The current CodeMemory repository indexed successfully: 35 source files, 15 excluded entries. `createProjectContext` resolved first to its function declaration in `packages/shared/src/index.ts`. A second index returned `UNCHANGED`, zero changed/deleted files and generation 1. This smoke test first discovered duplicate unresolved identities for nested calls; regression 002 reproduced the failure before the fix.

The Phase 3 smoke test indexed 52 files with 15 excluded entries using the new parser. An immediately repeated compiled-CLI index returned `UNCHANGED`, zero changed/deleted files and the same generation (25). The earlier 35-file sample above records the initial foundation run.

An idle PostgreSQL backend was deliberately terminated in a regression test. The pool reported the disconnect and successfully opened a replacement connection; the process stayed alive.

## Phase 5 query verification

All indexed application tools were exercised with `store.snapshot` replaced by
a failing spy; no snapshot read occurred. Integration tests also cover a new
index published during a read transaction, stable pagination, foreign-project
IDs, escaped LIKE characters, bounded snippets, 1,100-neighbor traversal,
cycles in both directions, a five-second blocked-query timeout and recovery,
and migration 1 → 2 without symbol row rewrites.

A separate synthetic run on 2026-09-11 used 10,000 small TypeScript files:
initial indexing 5,597 ms, unchanged recheck 2,578 ms, scoped symbol query
55 ms and process RSS at the end 103 MB (decimal). Command:
`bun run benchmark 10000`. RSS is not peak memory and this small-file synthetic
workload does not establish performance on large, complex real repositories.
The earlier 1,000-file numbers above are historical, not a controlled speedup
comparison.

The real repository was upgraded to migration 2 and indexed at generation 37
(54 files, 15 exclusions). Compiled-CLI lexical search returned six `readIndex`
matches from that generation; a repeated index returned `UNCHANGED` with zero
changed/deleted files.

## Phase 6 memory verification

Five memory integration tests cover combined filters, literal wildcard text,
SQL pages without snapshot reads, pre-index availability, canonical and legacy
paths, retained memories after deletion/clean, foreign IDs, nested repository
rejection, concurrent superseding and migration 3 without row rewrites.
A new real-CLI test exercises creation, filtering, superseding, archive and
inactive history. The SDK MCP test also creates and filters a scoped memory
and rejects repository-ID injection. All 57 tests passed locally.

## Phase 9 recovery and real-project probe

Final standalone local verification: 62 tests passed, along with lint, typecheck
and build. This includes source-read retry, durable stages, stale-owner
reconciliation, an actively held database connection being terminated, and a
separate Bun lock owner killed by SIGKILL. A failing snapshot spy confirms index
reconciliation uses the compact file manifest.

The public TypeScript v6.0.3 source at commit
`050880ce59e30b356b686bd3144efe24f875ebc8` was sparsely checked out and explicitly
scoped to `src/compiler`, using a disposable database. With the default 2 MiB
file limit: 77 files (one excluded), 9,400,075 total source bytes including the
skipped file, 33,798 symbols, 177,089 edges, 4,305 unresolved references and one
diagnostic. The response correctly reported `incomplete: true`; this is not a
complete TypeScript-project coverage claim. Initial indexing took 77.7 s,
unchanged reconciliation 11.9 s, first scoped symbol search 1.46 s and parent
RSS at the end 47 MB. These timings predate the compact-manifest optimization.

A second probe raised the file limit to 16 MiB. It caused substantial local
PostgreSQL I/O contention during edge publication and was stopped before
completion. Its verified temporary database was removed. Concurrent test
execution was canceled and then rerun alone successfully; no result from that
contended run is used as final verification. Full large-file compiler performance
and total peak worker memory remain open Phase 9 work. The reproducible script
is `scripts/verify-project.ts`; an abruptly killed script can leave a temporary
database and should be cleaned up only after verifying its repository root.

After the compact-manifest change, a separate 10,000-small-file synthetic run
completed: initial indexing 16.2 s, unchanged check 10.2 s, symbol query 424 ms,
parent RSS at end 54 MB. The machine had recently handled the contended probe;
these runs are not a controlled speed comparison. The regression test proves
that full graph snapshots are no longer read, not a specific latency improvement.
The real CodeMemory repository also upgraded through migration 4 and indexed
57 files at generation 62; doctor reported COMPLETE/SUCCEEDED, no interrupted
owner and no source read errors.


## Parser ownership and offline acceptance (alpha.6)

- Local suite: 76 tests across 12 files passed, including execution-scope caller
  ownership, each isolated worker failure mode and validated custom deadlines.
  Lint, type checking and the CLI build passed.
- The standalone offline command passed on regression 005: one file, 19 symbols,
  43 edges, no duplicate IDs, dangling edges or foreign file ownership. Its one
  unresolved call is intentional.
- A private real-project POS scope completed offline: 943 sources, 11,566,067
  bytes, 110,256 symbols and 261,190 edges. Final parser wall time was 64.97 seconds,
  measured before validation and queries. Duplicate symbol/edge IDs, dangling
  edges and foreign file ownership were all zero; there were no diagnostics and
  46,155 unresolved targets under the documented static-analysis limits.
- The originally observed local-initializer caller defect now resolves to its
  surrounding function. A repeated scan found no changed/deleted inputs. Private
  source paths, symbol details and raw probe output are not published here.
- These offline probes do not verify database indexing, SQL query latency or
  production throughput. The earlier POS timing included offline queries and
  validation, so it cannot be compared with this parser-only measurement.
- Before lazy compiler-program processing, the full private monorepo (4,266
  sources, 45,588,516 bytes) exceeded both the default 120-second deadline and
  an explicit 300-second deadline. Increasing the timeout alone was not a fix.
- After lazy compiler-program processing, the same full monorepo still exceeded
  the explicit 300-second budget (300.35 seconds including shutdown). The bounded
  failure path worked; no full graph was returned or published. Phase 9 remains
  open. These runs are not evidence of a parser throughput improvement.
- The final POS recheck after lazy processing retained the same graph counts,
  corrected caller and zero integrity failures. Its 64.97-second parser result
  is a single observation, not a controlled speedup or peak-memory claim.


## Parser profiling and transient allocation work (alpha.7)

Local lint, type checking, CLI build and 77 tests across 12 files passed. The
profiling CLI's bounded-stop smoke test passed, and a unit test checks complete
graph equivalence with profiling enabled/disabled. See `parser-performance.md`
for the real-project record comparison, CPU evidence and remaining gates.

## Bounded watcher endurance (alpha.8)

On 2026-09-11, all 79 tests across 13 files passed locally (38.78 seconds).
Lint, TypeScript checking and the CLI build also passed. The new real-watcher
regressions cover 12 change bursts, three injected parser failures, four session
restarts with offline edits, and an explicitly blocked analysis with a later
queued write. See hardening.md for assertions and test boundaries. No runtime
fix was required by these scenarios. Multi-hour soak testing, large-repository
publication/query acceptance and peak-memory bounds remain unverified.

# Verification evidence

Recorded on 2026-09-11. See the development tracker for release scope.

- Dependency installation with Bun succeeded; versions are locked in bun.lock.
- PostgreSQL + pgvector Compose service started healthy.
- Tests create fresh randomly named databases and apply migrations; test databases are removed afterward.
- Phase 6 local checks passed: `bun run lint`, `bun run typecheck`, `bun run test` (57 tests across 10 files), and `bun run build`.
- Test split: 30 unit, 20 PostgreSQL integration, 7 real CLI/MCP E2E.
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

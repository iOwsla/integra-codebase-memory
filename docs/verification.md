# Verification evidence

Recorded on 2026-09-11. See the development tracker for release scope.

- Dependency installation with Bun succeeded; versions are locked in bun.lock.
- PostgreSQL + pgvector Compose service started healthy.
- Tests create fresh randomly named databases and apply migrations; test databases are removed afterward.
- Final local checks passed: `bun run lint`, `bun run typecheck`, `bun run test` (25 tests across 6 files), and `bun run build`.
- Test split: 12 unit, 7 PostgreSQL integration, 6 real CLI/MCP E2E.
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

An idle PostgreSQL backend was deliberately terminated in a regression test. The pool reported the disconnect and successfully opened a replacement connection; the process stayed alive.

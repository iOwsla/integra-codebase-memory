# Changelog

## 0.1.0-alpha.6 — 2026-09-11

### Fixed
- Calls inside local initializers now belong to their enclosing execution scope; unresolved calls follow the same rule. Parser revision 4 forces re-analysis to repair existing edges.
- Parser worker timeout, output limit, startup, input, exit and invalid-JSON failures are distinguishable; failed workers are forcibly stopped and their buffers/timers released.
- Compiler configuration membership and virtual paths avoid repeated scans; module resolution caches remain isolated by owning configuration and program.
- Syntax-only declaration collection and lazy semantic programs avoid retaining every compiler project simultaneously; cross-project targets retain file/offset identity.

### Added
- `bun run verify:parser /absolute/project` performs offline parser and graph-integrity acceptance without database access or source execution.
- Validated per-project parser deadlines (`parserTimeoutMs`, 1–600 seconds, default 120); offline probes can override the deadline without editing the selected project.
- Synthetic call-owner regression coverage and isolated worker lifecycle tests; 76 tests pass locally.

### Known limitations
- Phase 9 remains open for full-monorepo performance, large graph publication and total worker peak-memory validation. This release does not claim stable-release readiness.

## 0.1.0-alpha.5 — 2026-09-11

### Added
- Durable index stages and interrupted-owner detection in status/doctor; migration 4 adds latest-attempt records. Upgrade with `bun run db:migrate`.
- Recoverable source read failures are recorded per file and retried on later indexing. Healthy files remain queryable with explicit incomplete status.
- Recovery tests for parser errors, active database disconnects and SIGKILL; 62 tests pass locally.
- An explicit-root, disposable-database real-project verification script and documented large-file performance limits.

### Fixed
- Lost lock-owning database connections release their pool slots without an unhandled client error.
- Index reconciliation now reads a compact file manifest instead of transferring the full graph.

### Known limitations
- Phase 9 remains open: the full TypeScript compiler probe at a 16 MiB file limit was stopped due to local database I/O contention. This alpha does not claim stable-release readiness. See docs/verification.md and docs/hardening.md.

## 0.1.0-alpha.4 — 2026-09-11

### Added
- Phase 6: SQL-paged memory search with type, all-tags, exact-scope and inactive-history filters.
- CLI options for scoped/tagged creation, superseding and filtered pages; MCP uses the same validated filters.
- Migration 3 adds memory paging/filter indexes without rewriting records. Upgrade with `bun run db:migrate`; index creation can lock busy tables.
- Memory lifecycle, concurrency, isolation, upgrade and CLI/MCP coverage (57 tests total).

### Changed
- New file/directory memory targets are validated and stored as canonical relative paths. Symbol existence is checked atomically when saving, without loading the code snapshot.
- Repository scopes reject targets; directory/file scopes reject mismatched target types. Search remains available after source deletion and code cleanup.
- Phase 9 hardening and the stable-release gate remain open. See docs/memory.md for filter semantics and legacy paths.

## 0.1.0-alpha.3 — 2026-09-11

### Added
- Phase 5: scoped SQL symbol/code search, paged relationships and outlines, bounded file snippets and graph traversal.
- Generation-consistent read transactions, query timeouts, stable ordering and seven query/upgrade integration tests (51 tests total).
- Additive migration 2 for search and directed relationship indexes. Run `bun run db:migrate` when upgrading; index creation can briefly lock busy tables.

### Changed
- Index queries no longer load full project snapshots. Fuzzy ranking now uses PostgreSQL pg_trgm; scores and fuzzy candidates can differ.
- File context rejects lines beyond indexed content with `INVALID_RANGE`. See docs/search.md for pagination, timeout and upgrade semantics.
- Remains an alpha source release; memory filters and broader hardening are still open.

## 0.1.0-alpha.2 — 2026-09-11

### Fixed
- GitHub Actions service health-check quoting now allows PostgreSQL to start on hosted runners.
- The alpha.1 tag is retained unchanged; its release was blocked by CI before tests ran.

### Included
- Includes the project-scoped foundation and Phase 3 parser improvements described below.
- Source prerelease; production gates and limitations remain open.

## 0.1.0-alpha.1 — 2026-09-11

### Added
- Bun workspaces, strict TypeScript, Biome, Vitest and PostgreSQL/pgvector migrations.
- Explicit session project isolation, bounded scanning, semantic TypeScript plugin and atomic graph publication.
- Bounded search, callers/callees, references, traversal, file context, project memory, CLI and MCP v2.
- Process-owned watcher, reconciliation, advisory locks and real STDIO lifecycle tests.

- Phase 3: bounded custom configuration references, virtual package.json workspaces, conditional exports and unbuilt project-reference source redirects.
- Permanent construct coverage for generics, decorators, namespaces, chaining, CommonJS and alternate source extensions.

### Changed
- The project-isolation amendment supersedes global project selection and global memory access.
- TypeScript 6.0.3 supplies the stable Compiler API; MCP uses official v2 packages.

### Fixed
- Regression 001: variable-bound function expressions retain binding identity; same-named declarations in separate blocks no longer collapse.

- Regression 002: nested unresolved calls include both source-span boundaries in their identities, preventing duplicate-key publication failures.

- Idle PostgreSQL connection errors are handled and logged without crashing the process; forced-disconnect recovery is integration-tested.

- Regression 003: exported value/binding flags, full overload ranges, separate accessors and property-use references.
- Regression 004: static CommonJS imports/exports, with local-name shadowing protection.

### Removed
- No previous release.

### Known Issues
- See docs/limitations.md for static analysis limits and remaining query, memory and release hardening work.

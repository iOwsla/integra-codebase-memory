# Changelog

## 0.1.0-alpha.13 — 2026-09-11

- Add Windows PowerShell bootstrap and source-checkout installers for explicit project-scoped Codex/Claude setup, without Bash.
- Add Windows PowerShell 5.1 and PowerShell 7 CI checks for previews, repeat installation, path handling, failures and published-release downloads.
- Document pinned Windows commands, prerequisites and runtime locations in English.
- Full native Windows database/indexer acceptance and existing stable-release gates remain open.

## 0.1.0-alpha.12 — 2026-09-11

- Add project-scoped dead-code candidates and exact-body duplicate reports with bounded pagination, source locations and explicit review requirements.
- Reindex TypeScript bodies with parser revision 5; expose reports through MCP and CLI.
- Add a pinned, stdin-safe curl bootstrap for explicit Codex/Claude project integration, dependency installation and no-write previews.
- Document prerequisites, repeat installation, configuration conflicts and explicit upgrades in English.
- Stable release gates for long-duration, large-project and memory acceptance remain open.

## 0.1.0-alpha.11 — 2026-09-11

### Added
- `install.sh --project /absolute/project --client codex|claude|both [--write]` for explicitly project-scoped integration. Preview is the default.
- Merge client settings, maintain marked instruction blocks and ignore machine-local connection files while preserving unrelated settings. Repeated identical installation is a no-op.
- Installer E2E coverage for scope isolation, settings preservation, malformed/conflicting input, linked destinations and idempotence.

### Scope
- The installer performs no database or indexing work. Client startup triggers the selected project only; existing global servers remain independently configured. PostgreSQL and installed server dependencies are prerequisites.

## 0.1.0-alpha.10 — 2026-09-11

### Added
- Project-scoped Codex connection preview/installation with explicit source roots, automatic indexing and watching. Existing differing settings are preserved; redirected config directories are refused.
- MCP initialization guidance, task-specific tool descriptions and repository agent instructions for reference/impact checks and cautious DRY/dead-code reviews.
- Real MCP connection verifier for root, readiness, tools, symbol search and callers; transient index contention is retried.
- A stable-release acceptance checklist distinguishing completed transport setup from remaining quality-analysis, distribution and performance work.

### Scope
- Configuration does not automatically launch PostgreSQL, migrate databases or reload an existing AI client. Dedicated duplicate-code and dead-code reports remain pending.

## 0.1.0-alpha.9 — 2026-09-11

### Added
- `bun run simulate:project [seconds]` exercises a temporary copy of this repository with the production parser worker, disposable PostgreSQL index, watcher edits, injected failures and session restarts.
- Full baseline graph restoration and project-memory retention assertions, plus sampled parent/descendant RSS and SQL search timings.
- A five-minute local run completed 28 rounds, five recoveries and nine restarts. Original tracked source contents were unchanged.

### Scope
- Sampled RSS is not a peak-memory guarantee; the database is excluded. Long-duration and large-monorepo release gates remain open. Runtime indexing behavior is unchanged.

## 0.1.0-alpha.8 — 2026-09-11

### Added
- Bounded watcher endurance regression: 12 change bursts, three parser failures with automatic retry, and four session restarts with offline additions and subsequent deletions.
- A gated regression verifies that changes arriving during analysis are queued and converge without periodic reconciliation.
- Graph preservation, stale-symbol removal, edge integrity and final no-op reconciliation assertions.

### Scope
- Runtime behavior is unchanged. These synthetic correctness tests do not establish hours-long stability, large-repository throughput or peak-memory bounds. Phases 9 and 10 remain open.

## 0.1.0-alpha.7 — 2026-09-11

### Changed
- Parser declaration tables use numeric positions per canonical file; declaration classification, source text extraction and relationship line lookup avoid redundant work.
- Edge deduplication no longer creates an intermediate key/value tuple array. Call resolution rules and parser revision remain unchanged.

### Added
- Optional parser phase profiling and `bun run profile:parser /absolute/project [semantic-file-limit]`, with explicit incomplete-stop reporting.
- Profiling/non-profiling graph-equivalence coverage; 77 tests pass locally. Private application graph fingerprints match the original lookup implementation.
- A documented CPU and memory investigation, including unsuccessful experiments and the limits of wall-time comparisons.

### Known limitations
- Full-project performance and memory acceptance remain open. No end-to-end speedup or stable-release readiness is claimed; see docs/parser-performance.md.

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

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

## CodeMemory repository simulation (alpha.9)

On 2026-09-11, the new simulation runner exercised a temporary copy of the tracked
working-tree contents at commit `27c07270f8281f611d3bde33082fa9032970c7b3`.
Platform: macOS 15.6.1 arm64, Bun 1.3.3, local PostgreSQL. The copy contained 127
tracked files and indexed 62 source files, 3,068 symbols and 8,055 edges. The
new untracked runner itself was outside this sample.

`bun scripts/simulate-project.ts 300` exited successfully after 306.60 seconds,
including initial publication and final restoration checks. It completed 28
rounds, five injected-failure recoveries and nine watcher restarts. All original
graph records matched after probe removal, the project memory record survived,
and tracked source content hashes remained unchanged. Temporary resources were
cleaned up on successful exit.

| Observation | Value |
| --- | ---: |
| Initial index publication | 3.39 s |
| Median change-to-verified-graph time | 3.02 s |
| Maximum change-to-verified-graph time | 29.43 s |
| Median SQL symbol search | 19.05 ms |
| Maximum SQL symbol search | 560.17 ms |
| Final no-op indexing | 50.11 ms |
| Highest sampled parent + descendant RSS | 309.42 MiB |
| RSS samples / sampling errors | 601 / 0 |

Convergence includes polling, snapshot validation and injected-failure recovery,
not just parser execution. Search queried `createProjectContext` with limit 10.
These are observations from one paced run on the local device. Sampled RSS omits
PostgreSQL, can miss peaks and can count shared pages multiple times. This closes
a short real-codebase simulation check; multi-hour stability, total peak memory
and large-monorepo acceptance remain open.

Release checks: 79 tests across 13 files passed locally (38.08 seconds), along
with lint, typecheck and build. A separate 10-second exercise of the final staged
runner also restored the full baseline graph and completed successfully; this
short invocation is included in CI.

## MCP onboarding and client connection (alpha.10)

Local lint, typecheck and build passed. All 81 tests across 14 files passed
(86.14 seconds), including configuration preservation/idempotence, redirected
config-directory rejection and MCP initialization instructions received through
a real SDK client. The generated local configuration parsed successfully as TOML.

A standalone real MCP connection to this repository reported the correct root,
12 tools, automatic indexing and watcher enabled, index version 105 and incomplete
false. Exact `createProjectContext` search succeeded; the first caller page
returned 10 records. The verifier retries INDEX_BUSY instead of mistaking normal
concurrent index ownership for a permanent startup failure. This verifies the
transport and persisted index, not tool availability in an already-open AI chat.
The project-scoped client connection is installed locally and excluded from Git.

## Project-only installer (alpha.11)

All 92 tests across 15 files passed locally (35.52 seconds), along with lint,
typecheck, build and `sh -n install.sh`. Eleven installer E2E cases run the shell
entry from a foreign working directory, with an invalid database URL, and cover
preview without writes, explicit root/client validation, nested scope isolation,
paths with spaces, client selection, config/instruction preservation, idempotence,
malformed/conflicting configuration, ambiguous markers and linked destinations.

The installer was applied to this repository for both clients. It preserved the
existing Codex connection and shared instructions, added the local Claude project
connection and ignore block, then reported zero changed files on repetition.
Both machine-local config files are Git-ignored. This verifies file installation;
Claude Code's own trust/connection approval is still a client-side check.

## Candidate reports and curl bootstrap (alpha.12)

Disposable-database regressions verify candidate exclusions for exports, alias
exports, calls and callback references; self-recursion remains a review candidate.
Duplicate reports are paginated without snapshot reads, isolated across projects
and updated after source replacement. Parser fixtures cover line endings, literal
differences, overload implementations and arrows. Bootstrap fixtures cover stdin,
no-write previews, explicit scope, persistent downloads and failure cleanup.
The full suite contains 96 tests in 17 files. Hosted release CI must pass before
the prerelease is published; production acceptance gates remain open.

## Managed Docker and PostgreSQL setup (alpha.14)

Local macOS acceptance used a disposable real PostgreSQL Docker volume: health
checks, migrations, stop/restart and repeated setup preserved credentials and
stored data. Both client configurations and the managed launcher were exercised
with an intentionally invalid inherited application DATABASE_URL and a different
GUI XDG_DATA_HOME. Cleanup removed only that disposable owned volume.

The test suite has 107 tests in 18 files, including managed ownership/orphan
checks, lock cleanup, remote-context rejection and per-platform orchestration.
Linux CI repeats real service acceptance. macOS CI runs portable installer tests;
Windows CI runs PowerShell 5.1/7 project setup and mocked WSL feature preparation
with a restart-required result. Clean interactive Docker installation, vendor
prompts and actual WSL reboot acceptance are not established by these tests.

## Streaming parser and management CLI (alpha.15)

Local acceptance on macOS arm64 / Bun 1.3.3:

- A 257 MiB-plus synthetic output stream passes through the parser protocol without accumulating serialized output. Split UTF-8, configured limits, invalid records, deadlines and missing completion markers are covered.
- The real isolated parser passes the call-owner regression fixture with no duplicate symbols/edges, foreign symbols or dangling edges.
- A failed parser's safe error detail appears in session status and clears after successful recovery.
- Database-independent CLI installation, registration, disabling and re-enabling pass with an invalid database URL. Current-directory selection remains scoped to the child folder even under a parent Git repository.
- Real disposable Docker acceptance verifies health checks, migrations, persistence across restart and managed launcher database isolation. Unit coverage verifies explicit force-recreation does not remove volumes.
- The bundled CLI produces a launcher pointing to the source runtime; importing installer modules does not execute their standalone entrypoints.
- Update policy tests cover numeric alpha ordering, stable channels, draft exclusion, fixed release links, offline failure and disabled checks. Release-body text is never returned as assistant instructions.

The reported Windows project with 4,316 files / approximately 47 MB source is not available in this workspace. Full indexing of that exact project and clean-machine interactive Docker/WSL installation remain separate acceptance work; transport regression coverage does not establish their completion.

The alpha.15 upgrade follow-up passes 129 local tests across 21 files, lint,
typecheck and build. Upgrade E2E checks cover backups, no-write preview, retained
external database environment, unrelated MCP servers, repeated application and
refusal of database-mode or project-scope changes. Native Windows upgrade checks
are part of the release workflow rather than inferred from the macOS tests.


## Alpha.16 progress and result clarity (2026-09-12)

Local verification: lint, TypeScript check and CLI build passed. The full suite
passed 139 tests across 25 files; subsequent affected MCP/diagnostic checks passed
13 tests, followed by the final three response-contract tests. The offline worker
check emitted six progress events with parser revision 6, 19 symbols, 43 edges,
and zero duplicate/dangling/foreign records.

Added coverage includes stderr progress versus stdout JSON, read-only status
watch interruption, worker progress transport, syntax locations and diagnostic
pagination, separate exclusion reasons, valid-source queries under incomplete
coverage, runtime/job identity, long-function/long-line preview continuation and
adaptive result pages traversed without loss. Fresh disposable databases were used.

These are fixture-level checks. The reported large Windows repository completion
and interactive latency remain user-reported observations, not local reproduction
or concurrent-load acceptance. Automatic stale-process retirement, release-folder
cleanup and full large-repository lifecycle testing remain open.

## Alpha.17 shared updates and lock contention (2026-09-12)

Local macOS verification passed lint, typecheck, CLI build and the full suite:
143 tests across 26 files. Database tests use fresh disposable databases.

The native upgrade acceptance script creates two registered project fixtures,
legacy MCP processes and an unrelated Bun process. It verifies that conflicting
settings reject activation without changing the first project or stopping any
process. Successful activation migrates both projects, preserves unrelated
settings/processes, selects the new version through the shared launcher and is
repeatable. Cached legacy commands resolve to the active version; originals are
retained in the private rollback backup. An invalid database URL verifies this
flow does not depend on database provisioning or indexing.

PostgreSQL regressions verify failed lock acquisition emits no non-owner unlock
notice and cannot release another session's lock. Contention uses bounded retry
backoff, reports BUSY, and recovers after lock release. Queries mark known stale
generations incomplete during pending/active work, including reads from a separate
CLI connection, then clear the stale flag after publication.

Native Windows process retirement and PowerShell 5.1/7 installers, macOS installer
tests and the Linux full suite are required hosted gates for this release. Local
macOS results do not establish Windows acceptance. Full large-monorepo concurrent
lifecycle testing, release-folder garbage collection and graph/Prisma field-report
items remain open; see [field feedback](field-feedback.md).

Hosted alpha.17 [CI](https://github.com/iOwsla/integra-codebase-memory/actions/runs/34656601806)
and [release verification](https://github.com/iOwsla/integra-codebase-memory/actions/runs/34656785679)
passed on Linux, macOS and Windows, including native process retirement and both
PowerShell versions. A subsequent published-package smoke check exposed the CLI
version-option collision described below; the alpha.17 tag was not changed.

## Alpha.18 update argument routing (2026-09-12)

The root CLI now parses options positionally so `update --version <release>`
reaches the update command instead of printing the installed CLI version. The
native upgrade script rejects an invalid selected tag without network/database
access and verifies that ordinary shared-launcher `--version` still works.

Local lint, typecheck and build passed, followed by five targeted tests in three
files covering upgrade activation, management state and runtime diagnostics.
The hosted full suite and all native platform gates must pass for this release.

## Alpha.19 Prisma schema and usage graph (2026-09-12)

Local lint, typecheck, frozen dependency installation and CLI build passed. The
full suite passed 155 tests in 28 files. Twelve Prisma checks cover located
models/fields, mappings, named relations, composite keys, enums, multifile groups,
independent clients, package boundaries, syntax failures, renamed clients,
constant/delegate aliases, ESM imports, CommonJS imports with shadowing protection,
extracted methods, typed delegates, transaction callbacks and isolated worker
transport. Negative cases avoid inferring Prisma from names or mutable aliases.

Disposable PostgreSQL acceptance verifies model lookup, operation metadata,
complete usage pagination and replacement after source deletion/renaming. Broken
schema syntax makes coverage incomplete and removes obsolete model symbols. An
`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)` check with 10,000 relationships confirms
the selective usage query uses an existing incoming-edge index. No new migration
or duplicate index is introduced. This fixture does not establish production
latency or complete large-monorepo coverage.

Native Windows and macOS CI run the Prisma parser/worker cases as release gates;
Linux runs the full suite. Runtime factories, dynamic arguments, raw SQL and
nonstandard client mappings remain limited as described in [Prisma coverage](prisma.md).

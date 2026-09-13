# Document and Git history memory verification

Date: 2026-09-13. Status: local development implementation, not a release.
Baseline: alpha.28, commit 254b3b8, with uncommitted history implementation changes.
Published alpha.28 does not contain this functionality.

## Executed checks

| Command | Result |
| --- | --- |
| `bun run lint` | Passed, 127 files |
| `bun run typecheck` | Passed |
| `bun run test` | 206 tests across 38 files passed, 76.83 seconds |
| `bun run build` | Passed |
| `bun scripts/verify-upgrade.ts` | Passed on macOS |
| `bun scripts/benchmark-history.ts` | Synthetic fixture passed |
| `bun scripts/benchmark-history.ts --project <selected-repository>` | Actual CodeMemory checkout passed |

Database tests and benchmarks used disposable databases. The shared project
database was not migrated and project collection/provider permissions were not
enabled as part of verification. Migration 7 remains an unpublished migration.

Tests cover exact Unicode/CRLF evidence slices, structural Markdown segmentation,
generated marker exclusion, bounded line diffs, initial collection, durable resume,
idempotent repeats, source deletion, merge parent comparisons, branch changes,
renames, binary/oversize coverage gaps, staged/unstaged/untracked observations,
Prisma locators, cancellation, project isolation, evidence freshness, explicit
candidate promotion, cleanup, and transactional backup/restore corruption handling.
CLI and MCP integration tests exercise the new routes and existing recall behavior.
Model extraction and verification in these tests use controlled providers.

The macOS upgrade script checks two-project migration, nondestructive preflight,
verified MCP process selection, active shared CLI selection, unchanged repeat
upgrades and legacy command redirection with original configuration backups.

## Actual repository measurement

The benchmark reads the explicitly selected checkout and writes to a disposable
PostgreSQL database. It does not invoke model providers.

| Measurement | Observed value |
| --- | --- |
| Reachable commits processed | 42 |
| File changes | 1,109 |
| Source revisions | 1,172 |
| Stored excerpt bytes | 5,356,224 |
| Initial collection | 37,767.76 ms |
| Unchanged repeat | 250.33 ms |
| Query median / p95, 20 queries | 47.65 / 66.09 ms |
| Process RSS baseline | 125,878,272 bytes |
| Sampled process RSS peak | 157,663,232 bytes |
| Pending batches / recorded gaps | 0 / 0 |

PostgreSQL EXPLAIN selected a Bitmap Index Scan on `history_segments_search` for
the excerpt search. This confirms index use for that measured query, not every
query shape. RSS was sampled every 20 ms; it excludes PostgreSQL/Docker memory
and is not a guaranteed peak. These are single-process local measurements, not
a concurrency benchmark or performance guarantee.

The synthetic fixture contained 64 Markdown documents and four commits with
low-information messages. It produced 131 revisions and 67 changes; initial
collection took 1,657.25 ms and the unchanged repeat 173.75 ms.

## Remaining validation and release boundaries

- Native Windows and Linux execution was not performed in this verification run.
- Real Spark/Haiku inference using the new document prompt profile was not run;
  controlled-provider tests do not establish current provider availability or quotas.
- The large external kiosk repository and concurrent-client load were not tested.
- Source locators are syntactic evidence, not historical whole-program semantic
  resolution. Missing/shallow history and exclusions remain explicit limitations.
- No commit, tag, package publication or GitHub release was created by this work.
  Platform release gates must be executed and recorded before publication.

See [the usage guide](../history-memory.md) for opt-in configuration, privacy,
bounded collection, evidence review and recovery commands.

## Alpha.29 release preparation — 2026-09-14

The final alpha.29 working tree passed frozen installation, lint, typecheck,
206 tests across 38 files (75.20 seconds), build and the macOS upgrade script.
All 15 workspace/root manifests match alpha.29. A stale hard-coded version
expectation in the diagnostics test was replaced with the package version.
Windows and macOS CI now also run the new history unit tests. Platform release
results are recorded by the tagged GitHub Actions run; this local report does
not predeclare them successful.

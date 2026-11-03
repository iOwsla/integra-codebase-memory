# Changelog

## Unreleased

- The installed agent instructions start with a short "first steps" section: load deferred CodeMemory tools with one tool search, call `codebase_status` and `recall_context`, and a table of which tool replaces `grep`, `cat` or `find` for each kind of code question, with the cases where native tools remain right. The detailed protocol follows unchanged. The MCP server instructions carry the same preference. In a real session on a 5,660-file project an agent never loaded the listed tools and used 13 shell commands instead.
- `install-project --write` and upgrades put the managed block at the top of `CLAUDE.md` and `AGENTS.md`, moving an existing block there; project lines keep their order below it. A block that is already first is left unchanged. Previously a new block was appended after the project's own rules; in that project it sat at line 155 of 408.

## 0.1.0-alpha.36 — 2026-11-03

- `search_code` chooses its own file access order instead of relying on the planner, which cannot estimate how often a substring occurs in file content and alternately walked every file for a rare term or decompressed every trigram candidate for a common one. It walks growing path windows while matches are dense and switches to the project's trigram candidates once rechecking them looks cheaper; pages are unchanged. On kiosk-software-last a first page for a common word fell from about 1.2 s to 2–8 ms and for a rare or absent term from about 0.4 s to 14–22 ms; the slowest of 45 measured pages fell from 1.27 s to 0.34 s. On modpos-integra-erp rare terms fell from about 125 ms to 6–16 ms; `prisma.`, absent from the first 520 files in path order, rose from 16 ms to 62 ms. The alpha.35 notes overstated `search_code` (2–15 ms for a common word): that held only when the planner happened to choose the path order.
- Migration 15 replaces the partial content trigram index with `files_content_repo` on `(repository_id, lower(content))` using the `btree_gin` extension, so a project's candidates no longer include other projects' files. It rebuilds one index (about 5 s for 8,800 files).

## 0.1.0-alpha.35 — 2026-11-03

- Migration 14 stores each file's generated flag in a `generated` column. `search_symbols` and the dead-code and duplicate reports no longer decompress a file's whole source for every candidate symbol: on kiosk-software-last `search_symbols get` (7,018 candidates) fell from 151 ms to 23 ms.
- Migration 13 indexes non-INDEXED files by the `file_status` column. The incomplete-coverage check that runs before every query no longer detoasts every file's content: per-call overhead on a 5,660-file project fell from about 59 ms to 1 ms.
- Indexing an unmigrated database now fails with `SCHEMA_OUTDATED` ("Run codememory system setup to migrate") instead of a raw "column does not exist" error. That error and database connection failures retry once per `reconcileMs` instead of backing off exponentially, so open sessions recover soon after setup.
- Migration 12 adds a trigger that derives the `files` metadata columns from the stored JSON on every write, so an older release (or manual SQL) that writes only the JSON can no longer leave stale hashes that hide changes or keep an outdated graph. Rows that already drifted are queued for the backfill once, and publication also rewrites a row whose columns disagree with its JSON.
- The post-publish `ANALYZE` runs only for tables whose written and deleted rows exceed 10,000 and 10% of the table's estimated size (or that were never analyzed), and logs them as `tables`. A one-file edit in a small project no longer analyzes the shared tables of every project.
- A chokidar watch error (for example `ENOSPC` from the inotify limit) stays in `codebase_status` as `watcher: false` with `watchError` until the session restarts. Events from paths still watched no longer clear it; changes under the unwatched paths are found by the periodic reconcile.
- `install-project --write`, `system install-cli` and `system setup` rewrite the shared launchers under the update lock, so a lock left by a killed update (dead process, or empty and older than 10 seconds) is recovered instead of blocking them.
- A failed `ROLLBACK` after a lost connection no longer replaces the original error (for example `57P01`); the connection is discarded.
- A `.codememoryignore` that links outside the project, into a nested repository or nowhere (dangling) now fails the scan with `IGNORE_FILE_OUT_OF_SCOPE` instead of indexing the files it would hide. Such a `.gitignore` is still treated as absent, as git does, but is counted under `exclusions.byReason.IGNORE_FILE_OUT_OF_SCOPE.other` (not `files`) with an `exclusions.diagnostics` entry naming its path. Ignore-file text is stored under the walked path, never the link target.
- The scanner's nested-repository fast path no longer applies to a path resolved through a symlink, so a directory swapped mid-scan for a link into a nested repository is rejected with `PATH_OUT_OF_SCOPE` again.
- MCP shutdown cancels the running index immediately instead of after pending background work, and bounds the whole teardown by one 10 s deadline. When a publish is still running at the deadline, the server logs `session_close_timeout` and exits with code 1 instead of waiting minutes for the database pool; PostgreSQL rolls back the open publish and releases the project lock.
- History workers also hold the alpha.34 global history-worker lock in shared mode, so a not-yet-restarted alpha.34 history process and a new worker can no longer process the same job at once. Workers for different projects still run concurrently.
- WIP capture writes an UNSTAGED deletion for a tracked file deleted mid-sweep instead of a NOT_FOUND gap, and re-checks the worktree path set once at the end of the sweep; a changed set records `WIP_SCOPE_CHANGED` and an INCONSISTENT cursor.
- The history excerpt quota re-reads the stored total before failing with HISTORY_QUOTA, and `history cleanup --apply` resets the cached total of in-flight collections. Automatic collection paused by HISTORY_QUOTA resumes once space has been freed.
- Turning `excludeGenerated` off with an unchanged HEAD now re-walks Git history, so generated sources that are now allowed are collected.
- Ctrl+C, SIGTERM or SIGHUP during a bootstrap upgrade (`install.sh` / `install-project.ts --write --upgrade`) now rolls back project configs and the management CLI at the next step and releases the update lock, like `codememory update`; the installer exits with code 130.
- The runtime launcher no longer fails with a raw `ENOENT` error when an empty update lock is removed between its read and its age check; the launch proceeds.
- Parser crash messages in `codebase_status` no longer expose absolute paths: the project root becomes `.` only at a path boundary (a sibling such as `/a/project2` is no longer rewritten to `./ject2`), the home directory becomes `~`, and other absolute POSIX or Windows paths collapse to `…/` plus the file name.
- Migration 11 drops the foreign keys and primary key of `symbol_edges`. Publication now deletes edges of removed symbols itself, matching the former cascade. On 300k real edges this raised edge insert throughput 2.3-2.5x and halved WAL volume.
- Record the receiver's static class/interface on call edges (`receiverType`). `find_callers` drops a dispatch row whose receiver is a class that is not an ancestor of the queried member, so calls on a sibling subclass that inherits the base member are no longer reported as possible callers of an override. This class check is a nominal heuristic: under TypeScript's structural typing a structurally compatible object can still reach the override at runtime. Rows whose receiver is an interface are always kept. The analyzer version changes, so existing indexes re-analyze once.
- evaluate-project: exclude `this` keyword matches and inherited-member calls on sibling receivers from the language-service oracle.
- Incremental publication sends, upserts and deletes symbols only for files whose analysis changed, instead of every symbol in the project, and no longer forces a synchronous full GC every 50,000 rows. `CODEMEMORY_PROFILE=1` reports a `digest` phase.
- A configuration-only change (for example `package.json`) no longer rewrites file rows whose stored data is unchanged.
- Duplicate unresolved-reference ids in one analysis no longer abort publication; the first row is kept.
- A dropped PostgreSQL connection during a query, memory search or memory save now rejects that call instead of crashing the process.
- Migration 10 drops the unused `symbols_fuzzy` and `edges_type` indexes, adds nullable `hash`, `file_status` and `analysis_hash` columns to `files` so scans and publication no longer read file content, adds `files_path_c` and adds `repositories.version_floor`. The columns are a catalog-only change, not a table rewrite; publication writes them, existing rows are backfilled in 500-row batches after the migration commits, and readers fall back to the stored JSON until then. Migrations run without the 30 s statement budget and fail after a 30 s lock wait instead of blocking readers. `codememory update` and `bootstrap --upgrade` now apply pending migrations to the managed database after stopping the old MCP processes and before switching the active runtime; a failed migration keeps the previous runtime. For a project on an external `DATABASE_URL`, activation only checks the schema: a database on an older migration blocks activation until `bun scripts/migrate.ts` has been run against it, while an empty or unreachable one lets activation continue with that instruction.
- A RUNNING index job whose owner no longer holds the project lock is reported as interrupted with `freshness: LAST_COMPLETED` in `status` and query metadata, not UPDATING.
- Publication keeps the latest 20 index runs per project; recording a failure prunes index errors older than 30 days.
- `clean` and `remove` delete set-wise under a 10-minute statement budget so large projects no longer hit the 30 s timeout. `clean` also deletes run history and the last index job, and later index versions continue above the pre-clean version.
- `debug unresolved` reads only the first 100 unresolved references by id and prints `{ total, results }` instead of loading the whole project snapshot.
- `search_code` walks matching files in path order through the new `files_path_c` index and stops at the page limit; on kiosk-software-last a first page for a common word takes about 2-15 ms.
- Order equal-score `search_symbols` results with non-test files first, then classes/interfaces, then functions/methods; scores and reasons are unchanged.
- Add `incomingByType`, `outgoingByType` and `usageIncoming` (excluding `DECLARES`, `EXPORTS` and self-edges) to `get_symbol`; `incoming`/`outgoing` keep their raw totals.
- Read the unresolved-reference count in dead-code and duplicate reports from the latest index run totals instead of counting rows on every page.
- Load `trace_dependencies` adjacency for a whole breadth-first level in one query; paths, truncation and bounds are unchanged.
- Detect Prisma queries through classes that extend a generated client, such as the NestJS `class PrismaService extends PrismaClient`, so `find_references` on a model or field lists those calls.
- Fix publication failing with a duplicate key when a composite `@relation` is missing more than one field; each missing pair is now its own unresolved record.
- Keep `find_callers` dispatch rows when calls with different receivers to the same member share a line; merged call edges keep only receiver metadata that every call agrees on.
- Resolve namespace-import references (`import * as utils`) to the imported file's FILE symbol instead of its first declaration.
- Report a TypeScript checker failure on one file as an `ANALYSIS_ERROR` diagnostic and continue with the other files instead of aborting the project analysis.
- The analyzer version changes again, so existing indexes re-analyze once.
- Cancel a running index when a session closes: the parser worker is killed, nothing is published, and MCP shutdown waits at most 10 seconds. A parser worker whose parent dies now exits within about a second.
- Back off retries of a failing index exponentially (from `reconcileMs` up to one hour, reported as `retryAfterMs`) instead of re-analyzing unchanged input on every reconcile; a file change retries immediately.
- Keep watcher failures visible in `codebase_status` (`watcher: false`, `watchError`) after later successful indexes, reconcile at once, and re-arm the macOS native watcher with backoff.
- Stop reporting an interrupted index job (RUNNING without its lock) as UPDATING in session status.
- Serve query freshness from in-memory session state instead of running the full status query before every tool call.
- Exclude `.gitignore` and `.codememoryignore` text from the index fingerprint so editing them no longer marks every file changed. Projects with ignore files re-analyze once after upgrading.
- Serve `get_file_outline` and `get_file_context` from the indexed snapshot for files deleted on disk, marked `sourceOnDisk: false`.
- Include the sanitized tail of parser worker stderr in the error when the worker crashes.
- Isolate background memory worker failures per project and log their error codes with the project scope.
- Raise the default `parserOutputLimitMiB` from 1024 to 4096. Configs written by `init` earlier keep an explicit `1024`; raise or remove it to use the new default.
- Report a `.codememory/config.json` that is not valid JSON as `CONFIGURATION_ERROR` instead of `INTERNAL_ERROR`, and accept a leading UTF-8 BOM.
- Keep scanning when a directory or config file disappears mid-scan (counted as `CONFIG_VANISHED`) or `.gitignore` is symlinked outside the root (`IGNORE_FILE_OUT_OF_SCOPE`). An unreadable directory now fails with `SCAN_UNREADABLE_DIRECTORY` naming its relative path.
- Index source files that contain a literal NUL byte instead of skipping them as binary; the NUL is stored as a space. Files with a UTF-16 BOM, mostly-NUL content or invalid UTF-8 with NULs are still skipped.
- Skip the repeated nested-repository ancestor check for files the scanner already vetted while walking, reducing per-file filesystem calls.
- Fix `codememory update` and `bootstrap --upgrade` never stopping running MCP servers: process discovery now accepts the installer's `--session-projects` flag in any order. An MCP process for a registered project that runs from an unverified checkout now blocks the update until its client is closed.
- Roll back activation on SIGINT, SIGTERM or SIGHUP and release `update.lock`; retire older release entries only after the active pointer is published, and treat an empty lock older than 10 seconds as stale instead of failing with a parse error.
- Let the shared launcher start when `update.lock` is stale (dead owner or an old empty file), report which live update blocks it, and refuse an active entry that forwards back to the launcher instead of spawning itself without end.
- Fix `projects remove` for paths reached through symlinks; a registration whose directory was deleted can still be disabled by its path.
- Run managed PostgreSQL with `max_wal_size=4GB`, `checkpoint_timeout=15min` and `wal_compression=lz4`; setup recreates the container and keeps the data volume.
- History collection keeps incremental Git collection after binary, oversized, generated, undecodable, symlink or submodule gaps; only other Git-stage gaps (`blockingGapCount`) force a full re-walk. Cursors written before this release fall back to `gapCount`.
- History collection lists commits in pages of 1,000, runs `git show` and `diff-tree` once per commit and parent, reads each blob with one Git process, discovers the worktree once per job for DOCUMENTS and WIP, saves job progress once per batch, and reads the excerpt quota baseline once per job.
- The history worker lock is per project, so a batch in one project no longer makes other projects fail with `HISTORY_BUSY`.
- Automatic history mode no longer adds a FAILED job every 30 seconds after `HISTORY_QUOTA`. Terminal collection jobs older than seven days are pruned, keeping the latest per worktree.
- WIP capture treats CRLF-only differences as clean and records filtered, ident, re-encoded and Git LFS pointer paths as `UNSUPPORTED_SOURCE` instead of reporting them as unstaged edits.
- `engineering_context` resolves HEAD once per request instead of once per search. Deleted history sources report `sourceState: NOT_FOUND` instead of `HISTORY_READ_ERROR`.
- An interpretation job interrupted by shutdown or a lost provider lease returns to the queue without consuming an attempt.
- Requeue a memory workflow job when the worker stops mid-inference (Ctrl+C or an MCP client disconnect) instead of marking it FAILED with `MEMORY_CANCELLED`; the interrupted run no longer counts toward the three-attempt retry limit.

## 0.1.0-alpha.34 — 2026-11-03

- Load TypeScript standard-library declarations (`lib.d.ts` and `lib.*.d.ts`) from CodeMemory's own TypeScript package during analysis. Member calls through `Record`, `Promise` and other built-in generics now resolve instead of being recorded as unresolved; library declarations are never indexed. The analyzer version changes, so existing indexes re-analyze once.
- Report interface and base-class dispatch in `find_callers`: calls through a supertype member an instance method implements or overrides are listed with `dispatch.via`. Constructors, static members and `super.member()` calls never dispatch; `super` call edges carry `receiver: "super"` metadata.
- Add `scripts/evaluate-project.ts`, a read-only quality and latency evaluation that compares relationship results with the TypeScript language service. Its `--unmanaged` mode indexes an unreleased build into a disposable database only.

## 0.1.0-alpha.33 — 2026-09-27

- Prefer the local OrbStack engine on macOS while retaining Docker Desktop support. Bind managed PostgreSQL state to its engine, provide an explicit fresh-engine path, and cap the managed container at one CPU and 1 GiB.
- Fix invalid Unicode in bounded TypeScript and Prisma previews that could abort publication on large projects.
- Use the native recursive macOS watcher, cache ignore rules, reduce idle reconciliation, and release TypeScript compiler graphs between project groups.
- Publish bounded database batches and selectively replace relationships for files whose analyzed records changed. Persist index totals for faster status reads, with compatibility for older generations.
- Add a disposable-database project profiler and regressions for engine selection, graph replacement, Unicode boundaries, and status totals.

## 0.1.0-alpha.32 — 2026-09-19

- Skip protected/out-of-scope Git collection candidates rather than aborting history scans with PATH_OUT_OF_SCOPE.
- Preserve strict explicit query path validation and exclude renamed changes with protected old paths.
- Add a real Git regression for protected files, bounded collection, excluded content and explicit path rejection.

## 0.1.0-alpha.31 — 2026-09-14

- Filter document-derived memory recall by task lexemes, evidence paths and latest checkpoint paths instead of returning every repository rule.
- Support directory-descendant matches with path component boundaries; preserve direct repository rules and approved scope/content.
- Preserve legacy database compatibility and cover source changes, restart, archive and project isolation.

## 0.1.0-alpha.30 — 2026-09-14

- Add DeepSeek and explicit OpenAI-compatible API profiles, project/workflow routing, native OS credential storage and a synthetic connection test.
- Preserve evidence validation and human approval across HTTP history and conversation workflows. Add persistent estimated usage allowances, request caps and safe diagnostics without provider fallback.
- Reduce default CLI help to everyday commands; retain all advanced commands and options through --help-all.
- Remove an unused legacy diff helper and enforce unused local/parameter checks in TypeScript.


## 0.1.0-alpha.29 — 2026-09-14

- Add opt-in Markdown and active-branch Git history collection with bounded, resumable jobs, exact source evidence and staged/unstaged observations.
- Add project-scoped history CLI/MCP queries, current source freshness, reviewed document rules and recall evidence links.
- Add migration 7, indexed excerpt search, quotas, retention, scoped backup and transactional restore.
- Keep model transmission separately opt-in and permanent rule promotion subject to explicit approval. Refresh English AGENTS.md and CLAUDE.md guidance.


## 0.1.0-alpha.28 — 2026-09-13

- Define semantic memory capture triggers and pending-review guidance in both client instructions and MCP status/tool descriptions.

- Memory protocol 2 extracts evidence segment IDs and resolves original quotes on the server, preventing model translation or spelling changes from corrupting quotes. Unknown and duplicate selections remain rejected.
- Reuse source fingerprints only within one checkpoint/recall request to avoid repeated reads of shared files without cross-request stale caching.
- Add Turkish/Unicode evidence regressions, a live Turkish provider probe and a reproducible checkpoint I/O benchmark.

## 0.1.0-alpha.27 — 2026-09-12

- Correct the root package version omitted from the alpha.26 commit. Includes the Claude Draft 7 compatibility fix and decision-to-code checkpoints; alpha.26 publication was blocked by CI.

## 0.1.0-alpha.26 — 2026-09-12

- Generate Draft 7 JSON Schema for Claude verification while retaining Draft 2020-12 for Spark. Classify CLI schema rejection as `MEMORY_PROVIDER_SCHEMA_UNSUPPORTED` and include exit status without exposing raw stderr.

- Add immutable decision-to-code checkpoints with bounded live file freshness checks, MCP/CLI access and recall summaries. Reported implementation and test results remain separate from independently observed source hashes.

## 0.1.0-alpha.25 — 2026-09-12

- Add task-scoped memory recall and an opt-in MCP evidence queue with Spark extraction, Haiku verification and explicit approval before promotion.
- Keep generated prompts and client instructions in English, preserve original-language quotes, validate exact schemas and bound classification correction.
- Add shared database worker locking, restart recovery, model cancellation on lease loss, bounded retries and per-candidate approval provenance.
- Add memory CLI configure/status/submit/candidates/review/recall/retry/worker commands; refresh both client instruction files.
- Add migration 5 for project workflow settings, durable jobs and recall indexing. Model processing is disabled by default.

## 0.1.0-alpha.24 — 2026-09-12

- Attach multiple registered projects to one MCP connection through client-reported roots or the agent's explicit `attach_project` call. Keep query, memory and watcher scopes separate; never expose all registrations.
- Enable session attachment in Codex/Claude installations and refresh complete marker-managed instructions in both AGENTS.md and CLAUDE.md on successful updates.
- Support repeated `--project` arguments for fixed workspaces. Require query project selection when more than one project is attached.
- Reduce oversized diagnostic page requests to 20 with explicit pagination metadata instead of rejecting the status call. Preserve validation for invalid types and nonpositive limits.

## 0.1.0-alpha.23 — 2026-09-12

- Add root `.codememoryignore` rules shared by scanning and watching, with configuration fingerprinting, scoped negations and explicit exclusion counts.

- Exclude `.workflow-tmp` path components by default across scanning, watching and direct source access. Temporary report syntax errors no longer make an otherwise valid index incomplete.
- Preserve diagnostics for actual source files and avoid broad report/tmp filename matching. Reconnect and reindex to remove previously indexed temporary files. No database migration is required.

## 0.1.0-alpha.22 — 2026-09-12

- Accept Prisma block comments through a string-aware, position-preserving parser adapter. Preserve original source, UTF-16 offsets and LF/CRLF line endings; keep unterminated comments diagnostic.
- Restore models, cross-file relations and static model queries when a schema contains `/* ... */` or `/** ... */`. Add worker, source-preview and coordinate regressions.
- Advance parser revision to 8 so unchanged projects rebuild their graph after the update. No database migration is required.

## 0.1.0-alpha.21 — 2026-09-12

- Persist and verify the shared CLI directory in Windows user PATH during installation and every update. Remove duplicate shared entries and obsolete launcher directories within the same installation; preserve unrelated and machine PATH entries.
- Refresh the PowerShell installer session and broadcast environment changes for newly launched applications. Existing terminal/IDE processes still need restarting after a CLI update.
- Add native PowerShell 5.1/7 regressions for persistence, legacy cleanup, unrelated entries, repeat repair and missing-launcher failures.

## 0.1.0-alpha.20 — 2026-09-12

- Normalize active runtime paths before deduplicating release folders. A trailing separator in the alpha.18 active pointer could otherwise cause duplicate legacy-entry rewrites and roll back the upgrade. Preserve Windows case-insensitive path comparison.
- Exercise a trailing-separator active pointer in native upgrade acceptance. Includes alpha.19 Prisma schema/usage support; no database migration is required.

## 0.1.0-alpha.19 — 2026-09-12

- Index in-scope Prisma schemas into located models, fields, enums, named relations and composite foreign-key edges. Preserve mapping and referential-action metadata; report syntax and unresolved schema diagnostics.
- Resolve Prisma model queries through proven client/delegate provenance, including renamed clients, constant aliases, destructuring, local imports, extracted methods, typed delegates and transaction parameters. Variable names alone never establish Prisma usage.
- Expose calling files, lines and query operations through existing model references, plus field references for literal query arguments. Keep independent/ambiguous schema clients isolated and document dynamic-resolution limits.
- Reuse existing PostgreSQL relationship indexes; verify the selective model-usage query plan over 10,000 edges. Add native parser, worker, pagination and source-replacement regressions. No database migration is needed; reconnect/reindex the selected project after updating to parser revision 7.

## 0.1.0-alpha.18 — 2026-09-12

- Fix `update --version <release>` being intercepted by the root CLI version flag. Keep ordinary `codememory --version` behavior and allow the selected published release to reach the updater.
- Add native CLI argument-routing regression coverage to the Windows/macOS/Linux upgrade acceptance check. Alpha.17 remains immutable; its unpinned `update` command and bootstrap upgrade are available.

## 0.1.0-alpha.17 — 2026-09-12

- Add stable shared CLI/MCP dispatchers and one-command published-release updates across registered projects, with version checks, preflight, backups and retained old runtimes.
- Redirect backed-up legacy entry scripts in managed release folders so cached client commands cannot restart the retired engine.
- Migrate registered project connections during a one-time bootstrap upgrade; stop only verified CodeMemory MCP processes and matched parser workers with process identity revalidation. Preserve project scope and avoid bulk indexing.
- Fix advisory unlock attempts by non-owners, add contention backoff and distinguish BUSY from ERROR. Mark known stale query results incomplete and report the served generation.
- Add two-project upgrade/process-isolation acceptance checks on native Windows/macOS/Linux and database lock/staleness regressions. Open clients still require reconnecting after upgrade.

## 0.1.0-alpha.16 — 2026-09-12

- Report syntax diagnostic kind/code and one-based line/column, bounded diagnostic pages, affected-file totals and explicit incomplete reasons. Split exclusion counts by file/directory/reason; retain valid-file queries when other files have syntax errors.
- Mark symbol/context preview truncation independently of index coverage, report returned lines and continuation guidance. Shrink oversized MCP result pages without skipping records; preserve coverage truth on response-size errors.
- Expose runtime version/PID/session, durable index-job ownership, supported source scope and unresolved-reference counts. Correlate public errors with redacted stderr diagnostic IDs; verify installer runtime targets before changing settings.

- Add throttled CLI index progress for scanning files, parser phases, publication and completion/failure. Keep stdout JSON clean; support `index --no-progress`.
- Add read-only `status --watch` and JSON-lines monitoring of durable job stages, including interrupted-job reporting. Published graph counts remain distinct from current work.
- Forward optional parser progress over the worker protocol for managed CLI workflows without mixing it into graph records or MCP output. Preserve foreground indexing behavior for existing large-project CLI users.
- Test progress throttling, terminal-control sanitization, quiet output, parser transport and end-to-end indexing/status monitoring; include a native Windows worker progress check.

## 0.1.0-alpha.15 — 2026-09-12

- Stream parser output as bounded newline-delimited records, replacing the fixed 256 MiB buffered JSON transport. Add validated `parserOutputLimitMiB` (default 1024, range 1–8192) and preserve safe parser diagnostics in MCP session status.
- Install a user-local management CLI before Docker/WSL/database provisioning. Add database-independent system status, setup/start/restart recovery, explicit project registrations and non-destructive project disabling. Selected-project recovery indexes only that project.
- Add explicit `--upgrade` / `-Upgrade` bootstrap and installer support with backups, same-project validation and preserved database mode/settings. Document existing-install upgrades for all platforms in README.
- Report newer public releases through `codememory updates` and MCP status. Cache checks per process, tolerate offline operation, support opt-out and instruct assistants to ask before updating; never auto-install.
- Add regression coverage for output larger than 256 MiB, split UTF-8, truncated streams, error recovery, offline CLI registration and release notification policy. Full affected Windows project acceptance remains outstanding.

## 0.1.0-alpha.14 — 2026-09-12

- Bootstrap installers now prepare Docker and dedicated PostgreSQL by default; connection-only mode remains available.
- Add macOS Docker Desktop, Windows WSL/Desktop and Ubuntu/Debian/Fedora Engine setup paths with explicit restart/elevation/first-run handling.
- Keep managed credentials and PostgreSQL 17 volume independent of release folders, validate ownership, wait for health and migrate only the managed database.
- Add a managed MCP launcher that reads private local credentials without placing secrets in project configuration.
- Test persistent restart, migration and launcher isolation with a disposable Docker database; retain existing stable-release and interactive platform acceptance gates.

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

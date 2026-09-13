# Document and Git change memory — Slice A: audit and contracts

Status: Slice A deliverable for review. It records the current-code audit, the
contract decisions for later slices and a draft additive migration. It does not
implement document or Git ingestion, retrieval, candidates or CLI/MCP surface.
Nothing here is published; migration 7 stays editable until the first release
that ships it.

Baseline: commit 254b3b8 (0.1.0-alpha.28) plus the uncommitted Slice A changes in
§8. Prepared 2026-09-13 on macOS arm64, Bun 1.3.3, Git 2.51.0 and the Docker
PostgreSQL 17 (pgvector) development service. Companion plan:
[document-and-git-memory-implementation.md](document-and-git-memory-implementation.md).

## 1. Method and evidence limits

- Evidence level: Verify. Claims below cite source lines read in this session.
- MCP (`integra_code_memory`, generation 158 at the start, `READY`,
  `incomplete: false`, 117 files): `codebase_status`, `recall_context` (no records),
  `memory_workflow_status` (disabled for this repository), `list_memory_candidates`
  (none), `search_symbols` and `find_references` for `GitCli` and `GitProvider`.
- Source fallback: native reads of the files cited below, plus text search for
  SQL table names, test assertions and imports that static analysis cannot prove.
- Not covered: runtime profiling, Windows, private repositories, real Git
  histories and model-provider calls.

## 2. Baseline checks before any Slice A edit

| Check | Result |
| --- | --- |
| `bun run lint` (Biome, 112 files) | pass |
| `bun run typecheck` | pass |
| `bun run test:unit` | 17 files, 112 tests passed |
| `bun run test:integration` | 11 files, 49 tests passed |
| `bun run test:e2e` | 6 files, 31 tests passed |

Integration suites create and drop a random database each
(`packages/test-utils/src/index.ts:17-36`). E2E suites redirect `XDG_DATA_HOME`
and `LOCALAPPDATA` to temporary roots. The `database_idle_connection_lost` line
comes from the pool error handler (`packages/database/src/index.ts:37`); it already
appears eight times in the baseline integration run, so it is not a Slice A
regression.

## 3. Verified plan statements

| Plan statement | Evidence | Result |
| --- | --- | --- |
| Six migrations exist; choose the next number at implementation time | Six entries in `packages/database/src/schema.ts` before this change; `PostgresStore.migrate` records `version = index + 1` (`packages/database/src/index.ts:53-61`) | Confirmed; the next migration is 7 |
| Existing evidence IDs are batch-local | `packages/memory/src/evidence.ts:11-19` builds `m{message}s{chunk}` over 800 code points | Confirmed |
| Candidate eligibility depends on user-message evidence | `packages/memory/src/workflow.ts:246-254` | Confirmed, with a sharper consequence: a candidate without user evidence but with `SUPPORTED` and `SUPPORTED_BY_EVIDENCE` falls through to `REJECTED` (`:260-264`), not `NEEDS_REVIEW` |
| The verifier requires user evidence | `packages/memory/src/protocol.ts:85` | Confirmed |
| `MemoryBatch` carries conversation roles only | `packages/core/src/memory-workflow.ts:3-7`; `packages/memory/src/protocol.ts:13` | Confirmed |
| Provider adapters are isolated | `packages/memory/src/provider.ts:15-24` accepts `input: unknown` | Confirmed; prompts and schemas, not the adapter signature, are conversation-specific |
| Checkpoint hashing is bounded | `packages/memory/src/checkpoints.ts:66-119`: 2 MiB per file, 8 MiB per request, `O_NOFOLLOW`, `SOURCE_CHANGED` detection, per-request reuse | Confirmed and reusable |
| Inspect worker locking before extending it | `packages/database/src/memory-workflow.ts:163-176` takes one session advisory lock, `codememory:memory-worker`, for every project; MCP polls every 3 s (`packages/mcp-server/src/index.ts:263-280`) | Confirmed; a long history job under this lock would starve conversation jobs |
| Migrations are applied explicitly | Callers: `scripts/migrate.ts:8`, `apps/cli/src/memory.ts:48,58`, `scripts/setup/services.ts:225`, `packages/test-utils/src/index.ts:26`; none at MCP startup | Confirmed |
| Client instructions are marker-bounded | Markers at lines 1 and 216 of root and template `AGENTS.md`/`CLAUDE.md`; writer at `scripts/install-project.ts:13` | Confirmed; root `AGENTS.md:217-223` has a repository-development section that root `CLAUDE.md` lacks |

## 4. Findings that refine the plan

1. **The scan already visits Markdown and discards it.** `RepositoryScanner` walks
   every entry and applies protected-path, symlink, configuration, `.gitignore`,
   `.codememoryignore` and nested-repository rules
   (`packages/indexer/src/scanner.ts:60-91`), then skips non-source files without
   recording them (`:94-96`). Document enumeration must reuse these rules instead
   of starting a second traversal.
2. **Ignore evaluation is already duplicated.** `packages/indexer/src/watch-policy.ts:8-49`
   reimplements the scanner's exclusions for the watcher. Slice B should extract
   one eligibility module shared by scanner, watcher and document enumeration,
   not add a third copy.
3. **An unused Git adapter exists.** `GitCli` (`packages/shared/src/git.ts:7-33`)
   implements `GitProvider` (`packages/core/src/index.ts:292-294`), but
   `find_references` returns nothing, no file imports `./git`, and
   `@codememory/shared` exports only `src/index.ts`. It is a dead-code candidate.
   Slice B should grow it into the bounded history adapter rather than add a
   parallel one; if B does not use it, remove it in a separately reviewed change.
4. **The watcher cannot see Git state.** `.git` is a protected path
   (`packages/shared/src/index.ts:40`), so commits, checkouts and resets never
   reach `ProjectSession.schedule` (`packages/indexer/src/index.ts:158-190`). Git
   state needs conservative polling tied to the reconcile interval (default 30 s,
   `packages/shared/src/index.ts:27`).
5. **Working-tree comparison can run repository-configured programs.** Clean and
   smudge filters, `core.fsmonitor`, external diff and textconv drivers come from
   repository configuration. Commit-to-commit reads avoid filters; working-tree
   comparison in Slice C should hash files itself and compare them with index
   blob IDs instead of running `git diff` against the working tree.
6. **Decoding must be lossless.** The scanner decodes with `toString("utf8")`
   (`packages/indexer/src/scanner.ts:121`), which replaces invalid bytes. Evidence
   must decode UTF-8 fatally and record `UNSUPPORTED_ENCODING` instead.
7. **Fixtures are required for `fx` behaviour.** This repository has 42 commits
   whose shortest subject is 14 characters, and 60 tracked Markdown files.

## 5. Contract decisions

These decisions bind Slice B and later slices unless a review replaces them.

**C1 — Separate evidence domain.** Documents and Git changes live in `history_*`
tables. `MemoryBatch`, `memory_jobs` and `submit_memory_batch` remain unchanged and
conversation-only. No document or commit is represented as a message.

**C2 — Identity inside the project scope.** `repository_id` remains the
canonical-root `projectScopeId` (`packages/shared/src/index.ts:112`). A worktree row
records how evidence was read: a `GIT` worktree hashes the scope, real git
directory, real common directory and object format; a non-Git project uses one
`FILESYSTEM` worktree. Linked worktrees have different roots and are separate
projects, so equal commit IDs never share rows across checkouts.

**C3 — Revisions and segments.** A revision is an immutable observation of one
file's bytes (`WORKING_TREE` or `GIT_BLOB`). Its ID hashes scope, worktree, source
kind, origin, path, object ID and content hash, so repeated scans are idempotent.
Segmentation is derived analysis keyed by `segmenter` (for example `markdown-1`);
a new segmenter adds segments without rewriting revisions. Segment IDs are global
deterministic hashes; Slice D prompts receive short job-local handles that the
server maps back. Positions are UTF-8 byte ranges plus 1-based lines. Excerpts are
exact, bounded and nullable, so a purge removes text but keeps provenance.

**C4 — Current association.** `history_document_heads` records each path's current
and previous revision. Deleting text or a file changes the head state; it never
deletes revisions or implies that a rule was revoked. Relocated paragraphs are
found through `history_segments.content_hash`.

**C5 — Commits and file changes.** Commits are keyed by object ID plus an explicit
object format (`sha1` or `sha256`). Parent order is preserved. Committer time is
display metadata, never a cursor. File changes are keyed by commit, comparison
parent (`EMPTY_TREE` for a root commit), old path and new path. A merge keeps one
comparison per parent; logical duplicates are collapsed when building candidates
or retrieval results, not by deleting rows. Raw patches are not stored; hunks are
bounded metadata, and source is re-read from Git, returning `SOURCE_UNAVAILABLE`
when an object has disappeared.

**C6 — Commit messages are attributed metadata.** Subjects are stored bounded and
labelled untrusted; they never decide classification or causality. Author email
addresses are not stored by default.

**C7 — Durable jobs with fencing.** `history_jobs` is a separate queue with at
most one `QUEUED` or `RUNNING` job per project and deduplication key, attempts, a
lease token and a lease expiry. Result writes must match the current lease token.
History work uses its own advisory lock namespace, never
`codememory:memory-worker`, processes bounded batches and yields between them.

**C8 — Cursors and coverage.** A job captures HEAD, worktree and policy generation
at start and pages through the full reachable graph of that HEAD, not only first
parents. Completion reconciles the reachable commit count with stored commits.
Incremental runs exclude previously covered tips. Shallow boundaries and missing
objects are recorded as coverage, never skipped silently. Timestamps are never
cursors.

**C9 — Separate permissions.** `history_settings` enables documents and Git history
independently (both default to false) and carries a policy generation. Permission
to send history evidence to model providers is a separate flag added with Slice D.
`memory_workflow_settings.enabled` never authorizes sending repository history.

**C10 — Lifecycle.** `clean` keeps history evidence, as it keeps memory; `remove`
deletes it through cascading foreign keys. Purge and retention belong to Slice F.

**C11 — Degradation before migration.** Servers do not migrate at startup, so
history reads must return an explicit `HISTORY_NOT_MIGRATED` result for a missing
table (`42P01`), following `packages/database/src/memory-workflow.ts:50-53`.

**C12 — Git adapter safety.** Argument arrays without a shell; deadlines and output
caps; `GIT_OPTIONAL_LOCKS=0`, `GIT_TERMINAL_PROMPT=0`, `-c core.fsmonitor=false`,
`--no-ext-diff`, `--no-textconv` and NUL-delimited output. Never checkout, fetch,
reset or write the index. Detect object format, git and common directories and
shallow state through `git rev-parse`.

**C13 — Source-neutral candidates (Slice D).** Evidence references become a tagged
union of conversation segment, document segment, and file-change side and range.
Eligibility is decided per source kind: conversation keeps the current
user-evidence rule; documented intent can enter review with its provenance but is
never classified as a user statement; diffs produce observations only. Adding a
source kind alone cannot satisfy this. Slice D must change three existing gates:

- the `hasUserEvidence` conjunct and `READY`/`NEEDS_REVIEW`/`REJECTED` mapping in
  `packages/memory/src/workflow.ts:246-264`, which today rejects any supported
  candidate that lacks user evidence;
- the promotion gate in `reviewMemory`
  (`packages/database/src/memory-workflow.ts:278-287`), which reads candidates only
  from `memory_jobs` and re-checks job state, `READY`, verdict and classification;
- the promoted record's `source: memory-job:…` format (`:311`) and the exact
  duplicate lookup limited to repository-scoped content (`:292`).

Conversation extraction stays on protocol `2`, and document or diff extraction
uses a separately versioned protocol, so retries of old jobs keep their contract.

**C14 — Retrieval compatibility (Slice E).** `recall_context` output stays
compatible. History retrieval is a new bounded read tool with distinct sections
(applicable rules, current code links, relevant changes, documented intent,
conflicts, verification gaps, provenance) and explicit current-applicability values.

**Default Markdown scope (settled by the plan, §6).** Slice B enumerates
working-tree Markdown through the scanner's eligibility rules: protected paths,
symlinks, configuration excludes, `.gitignore`, `.codememoryignore` and nested
repositories. Saved but untracked documents are therefore included unless ignored,
generated instruction marker blocks are excluded, and `.codememoryignore` gives
each project an override. Scope and counts are shown before collection is enabled.

## 6. Draft migration 7

Implemented in `packages/database/src/schema.ts:54-108`. It only creates tables and
indexes; no existing table is altered.

| Table | Purpose | Keys and scoping |
| --- | --- | --- |
| `history_settings` | Per-source opt-in, policy and policy generation | PK `repository_id` → `repositories` (cascade) |
| `history_worktrees` | Identity through which evidence was read | PK `(repository_id,id)` → `repositories` (cascade) |
| `history_revisions` | Immutable file-content observations | PK `(repository_id,id)`; FK `(repository_id,worktree_id)` |
| `history_segments` | Versioned segments with exact bounded excerpts | PK `(repository_id,revision_id,segmenter,ordinal)`; unique `(repository_id,id)`, which Slice D evidence references use; FK revision |
| `history_document_heads` | Current and previous revision per path | PK `(repository_id,worktree_id,path)`; FKs to worktree and revisions |
| `history_commits` | Commit objects with ordered parents | PK `(repository_id,object_id)` → `repositories` (cascade) |
| `history_file_changes` | File changes per comparison parent | PK `(repository_id,id)`; FK `(repository_id,commit_id)` |
| `history_jobs` | Durable bounded work with leases | PK `(repository_id,id)`; partial unique active deduplication key |
| `history_cursors` | Coverage frontier per worktree and stream | PK `(repository_id,worktree_id,stream)`; FK worktree |

Every row reaches `repositories` through NOT NULL composite foreign keys: directly
for settings, worktrees, commits and jobs; through the worktree for revisions,
heads and cursors; through the revision for segments; and through the commit for
file changes. This follows the existing `symbols` → `files` and
`memory_checkpoints` → `memories` pattern. New history tables must keep such a
chain.

Mapping to the plan's proposed entities: `collection_settings` → `history_settings`;
`source_revisions` → `history_revisions`; `evidence_segments` and
`document_sections` → `history_segments` plus `history_document_heads`;
`git_commits` → `history_commits` (parents as an ordered array); `file_changes` →
`history_file_changes`; `ingestion_jobs/cursors` → `history_jobs` and
`history_cursors`. Deferred: `symbol_changes` (added within Slice B once the
parser comparison design is settled), `ref_snapshots` and working-tree snapshots
(Slice C), `observation_records` and `evidence_links` (Slices D and E).

Secondary indexes cover only lookups Slice B will issue: revisions by path,
segments by content hash, file changes by commit and by old or new path, and the
job queue. They are provisional until Slice B checks them with `EXPLAIN` on
representative fixtures.

**Development-database caution.** While migration 7 is unpublished, do not run
`bun run db:migrate`, `memory configure` or `memory checkpoint` from this checkout
against the shared development database (127.0.0.1:55432): a later edit to
migration 7 would never re-run there. Tests use disposable databases. If it
happens, drop the `history_*` tables and delete `schema_migrations` version 7.

## 7. Contract sketches for Slice B and D

These types enter `@codememory/core` only when code uses them.

```ts
type RevisionOrigin = "WORKING_TREE" | "GIT_BLOB";
interface HistoryWorktree {
  id: string;
  kind: "GIT" | "FILESYSTEM";
  objectFormat?: "sha1" | "sha256";
  shallow?: boolean;
}
interface SourceRevision {
  id: string;
  worktreeId: string;
  sourceKind: "DOCUMENT";
  origin: RevisionOrigin;
  path: string;
  objectId?: string;
  contentHash: string;
  capturedAt: string;
  status: "AVAILABLE" | "SKIPPED_TOO_LARGE" | "SKIPPED_BINARY" | "UNSUPPORTED_ENCODING" | "READ_ERROR";
}
interface EvidenceSegment {
  id: string;
  revisionId: string;
  segmenter: string;
  ordinal: number;
  kind: string;
  lines: [start: number, end: number];
  bytes: [start: number, end: number];
  headingPath: { text: string; depth: number; occurrence: number }[];
  contentHash: string;
  excerpt: string | null;
  excerptTruncated: boolean;
}
interface FileChange {
  id: string;
  commitId: string;
  comparisonParent: string; // parent object ID or "EMPTY_TREE"
  kind: "ADDED" | "MODIFIED" | "DELETED" | "RENAMED" | "COPIED" | "TYPE_CHANGED";
  oldPath: string | null;
  newPath: string | null;
  oldObjectId: string | null;
  newObjectId: string | null;
  coverage: { status: string; reason?: string };
}
// Slice D
type EvidenceRef =
  | { kind: "CONVERSATION_SEGMENT"; jobId: string; messageId: string; segment: string }
  | { kind: "DOCUMENT_SEGMENT"; revisionId: string; segmentId: string }
  | { kind: "FILE_CHANGE"; fileChangeId: string; side: "BEFORE" | "AFTER"; lines: [number, number] };
```

## 8. Slice A changes and verification

| File | Change |
| --- | --- |
| `packages/database/src/schema.ts` | Draft migration 7, additive |
| `packages/database/src/index.ts` | `migrate(through)` applies migrations up to a validated version (default: all), so tests can build an older installation's schema; existing callers are unchanged |
| `packages/test-utils/src/index.ts` | `testDatabase({ through })` passes that version |
| `tests/integration/history-schema.test.ts` | New. Test 1 builds a database from migrations 1–6 only, seeds a memory, checkpoint, enabled workflow and queued job, confirms no `history_*` table exists and recall works, then migrates twice and checks unchanged row versions (`xmin`), versions 1–7, the new tables and the same operations. Test 2 seeds every history table and checks cross-project foreign keys, active-job deduplication, retention on `clean` and removal along each foreign-key chain on project removal |
| `tests/integration/queries.test.ts` | Expected migration list includes version 7 |

Results after the change: `biome check` pass on changed files; lint pass; typecheck
pass; targeted integration run (`history-schema`, `queries`, `memory`,
`memory-checkpoints`, `memory-workflow`) 5 files, 27 tests passed. Full suite
(`bun run test`): 35 files, 194 tests passed — the 192 baseline tests plus the two
new schema tests.

Mutation check: with `UPDATE memories SET data=data;` temporarily appended to
migration 7, the upgrade test failed on the `xmin` comparison; `schema.ts` was then
restored byte for byte and the full suite above ran on the restored file. The test
therefore detects a migration that rewrites existing rows.

No MCP tool, CLI command, public schema or client instruction changed. No model
provider was called. Nothing was committed.

## 9. Decisions requested from the maintainer

1. **Slice order.** Recommended: A → B → E → C → D → F → G. Deterministic
   ingestion and retrieval work with the provider workflow disabled, cost nothing
   per run and make most of the acceptance matrix testable before model-derived
   candidates add cost and promotion risk.
2. **Release cadence.** Whether Slice B ships alone, which freezes migration 7, or
   together with later slices.
3. **Real-repository acceptance.** Which checkout and machine run Slice G (for
   example the private kiosk repository on Windows), reporting results without
   private source.

## 10. Slice B outline

1. One eligibility module shared by scanner, watcher and document enumeration;
   existing scope and isolation tests must pass unchanged.
2. Markdown segmenter with exact byte and line ranges, CRLF and Unicode fidelity,
   distinct duplicate-heading identity and fatal UTF-8 decoding; record the library
   choice with footprint and licence.
3. Hardened Git adapter grown from `GitCli`: object format and shallow detection,
   paged reachable traversal from a captured HEAD, NUL-delimited name-status with
   rename detection, bounded blob reads.
4. A history repository composed into `PostgresStore` like
   `MemoryWorkflowRepository`, with idempotent upserts, fenced job leases and
   `HISTORY_NOT_MIGRATED` degradation.
5. CLI `history status|configure|scan` and read-only MCP status and listing tools.
6. Exit tests on synthetic repositories: an `fx` commit changing a refund function
   (exact old and new ranges, no invented rationale), repeat-run idempotency, root
   commit, merge with two parents, rename with spaces and a newline in the path,
   binary and oversize coverage, shallow boundary, interrupted backfill resuming
   without duplicates, and cross-project isolation.

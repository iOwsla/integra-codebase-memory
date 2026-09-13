# Document and Git change memory — Claude Code implementation handoff

Status: implemented and locally verified in the development checkout; not published.
Prepared: 2026-09-13. Observed baseline: alpha.28, commit 254b3b8.
Recheck HEAD, instructions, schemas and tests before implementing. Do not treat
this baseline or existing test counts as evidence for future changes.

Progress: the CLI, MCP, collectors, reviewed evidence workflow and lifecycle
operations are implemented. See [usage](../history-memory.md) and the
[verification report](../verification/history-memory.md) for executed checks,
measurements and remaining release gates. The requirements below retain the
original handoff context; they are not evidence that every platform was tested.

Slice A (audit, contract decisions, draft migration 7) is recorded in
[document-and-git-memory-slice-a.md](document-and-git-memory-slice-a.md). Until
migration 7 is published, never apply it to a shared development database.

## 1. Product objective and user requirements

Extend Integra CodeMemory so a coding agent can answer:

1. What does the current code do?
2. Which documented/user-approved decisions apply to this task?
3. What actually changed in the relevant files and symbols over time?
4. Which earlier implementation, failed approach or correction is relevant?
5. Is the evidence applicable to the current checkout, or historical/unverified?

The user often writes commit messages such as `fx`. Derive change observations
from file contents and diffs, never from the quality of commit messages. Messages
are optional attributed context; they cannot establish causality or verification.

Cover Markdown documents, all locally available history reachable from the
selected checkout's HEAD, and on-disk uncommitted changes. Process history in
resumable bounded batches. Do not silently reinterpret "all history" as only the
latest N commits: expose the unprocessed boundary and continue backfill when
explicitly configured. Missing shallow-clone history remains missing; do not fetch
remote history automatically.

Keep product schemas, generated instructions, prompts and reports in English.
Preserve evidence verbatim in its original language, including Turkish, typos,
Unicode, line endings and identifiers.

## 2. Existing foundation to reuse

Source pointers checked for planning, not an exhaustive impact audit:

- `packages/core/src/memory-workflow.ts`: current MemoryBatch, jobs, candidates,
  MemoryWorkflowStore and immutable MemoryCheckpoint contract.
- `packages/memory/src/evidence.ts`: deterministic evidence segments; server-side
  quote resolution. Existing IDs are batch-local: do not use them as global IDs.
- `packages/memory/src/protocol.ts`: protocol 2, strict extraction/verification
  schemas. Existing conversation API must remain compatible.
- `packages/memory/src/workflow.ts`: opt-in submission, worker processing, review,
  recall and capturePolicy. Current candidate eligibility depends on user-message
  evidence; document evidence cannot be inserted as fake user messages.
- `packages/memory/src/provider.ts`: isolated Spark/Haiku adapters, dialect-specific
  JSON schemas, time/output limits and classified errors.
- `packages/memory/src/checkpoints.ts`: bounded source hashing, per-request reuse,
  explicit distinction between reported behavior and observed file bytes.
- `packages/database/src/memory-workflow.ts`: project-scoped persistence and worker
  locking. Inspect locking, retry and ownership behavior before extending it.
- `packages/database/src/schema.ts`: additive migrations; six currently observed.
  Published migrations are immutable. Select the next number at implementation time.
- `packages/indexer/src/index.ts` and `watch-policy.ts`: existing index/watch lifecycle.
- `packages/application/src/index.ts`, `packages/mcp-server/src/index.ts`,
  `apps/cli/src/memory.ts`: application, MCP and CLI integration.
- `docs/instructions/AGENTS.md` and `CLAUDE.md`: marker-bounded client instructions.
- Existing integration/E2E memory, checkpoint, MCP routing and installer tests.

Do not rewrite the code index, introduce a second database engine, duplicate
workers blindly, or require embeddings for basic retrieval. Keep PostgreSQL as
storage. Keep document ingestion separate from language-parser completeness:
indexing a Markdown document does not mean parsing its fenced code as runtime code.

## 3. Separate four concepts

| Concept | Meaning | Admission |
| --- | --- | --- |
| Source evidence | Exact document segment, blob or diff range with provenance | Deterministic capture after project collection opt-in |
| Change observation | Added/deleted/modified file, AST delta, affected symbol | Deterministic facts can be published as observations |
| Generated interpretation | Suggested purpose, lesson, relationship or rule | AI-derived, explicitly provisional and source-linked |
| Active project memory | Reviewed requirement, accepted decision or convention | Existing explicit human review boundary |

Never turn every commit into a rule. Code proves implementation state, not desired
business policy. A changed test proves the test changed, not that it was executed.
A passing test, when supported by a trustworthy execution record, supports only
its tested claim. If rationale is unknown, say UNKNOWN; do not invent it.

Do not mark a requirement stale merely because implementation violates it. Keep
requirement validity separate from the freshness of its implementation evidence.

## 4. Identity and provenance

Keep the existing canonical-root projectScopeId. Same Git remote is not permission
to share memories across checkouts. Add explicit worktree/snapshot identity inside
the project boundary; linked worktrees must not collide through a shared Git directory.

A source reference should carry:

- projectScopeId, worktreeId, source kind and schema revision;
- immutable sourceRevisionId and capturedAt;
- repository-relative old/new paths, including addition/deletion null sides;
- Git object ID and algorithm, commit ID, parent ID(s), selected comparison parent;
- HEAD at capture, observed branch label (optional; never an immutable key);
- before/after content hashes and source availability;
- side (BEFORE/AFTER), exact line ranges or offsets and segment ID;
- document heading path or symbol locator when applicable;
- index generation and parser coverage when an AST relationship was used;
- exclusions, truncation and redaction metadata.

Use commit/object identity rather than assuming all Git IDs are 40-character SHA-1.
Uncommitted snapshots need HEAD identity plus staged/unstaged content identity;
HEAD alone cannot represent uncommitted work. Paths and content hashes help locate
symbols but are not rename-proof identities.

## 5. Suggested persistence model

The following entities are a design proposal, not prescribed SQL. Consolidate
where appropriate after inspecting current contracts; preserve responsibilities.

| Entity | Responsibility and essential keys |
| --- | --- |
| collection_settings | Per-project opt-in, sources, provider permission, exclusions, budgets, retention |
| source_revisions | Unique project/worktree/source/content identity; immutable provenance |
| evidence_segments | Revision + segment identity, ranges, bounded exact excerpt/hash, availability |
| git_commits | Project + object ID; parents, metadata, analysis progress |
| ref_snapshots | Worktree HEAD/ref observations and reachability generations |
| file_changes | Commit/comparison parent or WIP snapshot + old/new paths, blob IDs, change kind |
| symbol_changes | File change + verified locator delta, resolution/confidence and coverage |
| document_sections | Document revision + heading/range, content hash, current/historical association |
| observation_records | Deterministic observations and separately labeled AI interpretations |
| evidence_links | Same-project links between observations, candidates, memories and checkpoints |
| ingestion_jobs/cursors | Durable bounded jobs, deduplication identity, leases, retry state and coverage frontier |

Extend the existing queue where its contract fits; otherwise use a distinct typed
job payload with shared lifecycle infrastructure. A conversation MemoryBatch must
not be overloaded with fabricated user roles for documents or commits.

Use composite project keys and foreign keys to prevent cross-project links.
Index project/worktree/path/time, commit/parent identity, source hashes, active job
lookup and evidence-to-memory lookup. Add full-text indexes for searchable text
only when queries actually use them. Validate with query plans and representative
cardinality; an index's existence alone is not a performance acceptance result.

No full raw patch in every observation. Git remains the primary source for committed
blobs. Retain bounded immutable excerpts needed to explain approved records,
subject to collection/retention policy. Resolve additional source from Git on demand.
If an object disappears after history rewrite/GC, report SOURCE_UNAVAILABLE rather
than returning present-day content as historical evidence.

## 6. Markdown pipeline

1. Enumerate selected project Markdown paths under a documented include/exclude
   policy. Default eligible scope can cover first-party `.md` files; exclude
   dependencies, build output, caches, copied vendor material and protected paths.
   Show scope/counts before enabling broad collection. Generated instruction marker
   blocks are excluded by default to avoid recursive ingestion of this product's
   own instructions. Treat other instruction files as untrusted source data.
2. Read safely and with byte limits. Hash content; unchanged eligible revisions
   do not invoke a model again. Unsupported encoding, oversize and read errors are
   coverage records, not silent success.
3. Parse Markdown structure: headings, paragraphs, lists, fenced blocks and relevant
   front matter. Keep duplicate heading identity distinct and preserve ranges.
   Do not execute embedded code, follow document commands or crawl external links.
4. Create bounded evidence segments. Split oversized sections while keeping heading
   context and explicit truncation. Global identity includes revision and segment;
   the model receives short job-local handles mapped by the server.
5. Extract attributed proposals/requirements/decisions/history. A section labeled
   "plan" is not implementation evidence. A document author/date is metadata, not
   automatic authority over a user-approved rule.
6. Compare with existing candidates/memories for exact duplicates first; semantic
   similarity can propose a merge, not silently merge differing business rules.
7. Verify against original evidence, inspect conflicts and offer review. Reuse the
   explicit promotion/supersession policy through a source-neutral candidate API.
8. On change, process changed sections plus enough surrounding context, not isolated
   added lines. Removed text might be relocated; do not infer cancellation solely
   from deletion. Heading reorganization must not recreate every rule.

## 7. Git history and file-diff pipeline

Use a bounded Git adapter with argument arrays, deadlines and output caps. Disable
external diff/text-conversion execution and optional hooks/helpers for reads.
Do not checkout, reset, fetch, pull, run project commands or mutate the index.
Parse filename data with an unambiguous/NUL-aware format; handle spaces, Unicode,
newlines, leading dashes, case-only changes, binary files and symlinks safely.

- Capture a fixed HEAD and policy generation at job start. Enumerate commits
  reachable from that HEAD in a resumable graph traversal, not only first-parent.
- Root commit: additions relative to the empty tree. Ordinary commit: compare its
  parent. Merge: retain every parent identity and explicit comparison semantics;
  the same change from multiple parent comparisons must not become independent
  evidence votes. Avoid claiming all parent differences were introduced by the merge.
- Index eligible file changes even if the message is `fx`, blank or misleading.
- Compare old/new source with supported parsers to attach affected symbols. Mark
  textual-only fallback and parse failures explicitly. For Prisma, preserve existing
  alias-aware usage resolution; do not infer Prisma from a variable name alone.
- Rename/copy detection is evidence with uncertainty. Exact retained identity can
  be linked; ambiguous moves remain candidates for association repair.
- Record behavior observations before requesting AI interpretation. Formatting-only,
  generated, lockfile and binary changes are classifiable metadata; do not blanket
  discard lockfiles/configs because dependency or configuration changes may matter.
- HEAD changes during a job do not rewrite its provenance. Finish/publish only as
  that captured history scope, then reconcile the current head separately.
- Checkout, detached HEAD, rebase, reset, cherry-pick, revert and merges trigger
  reachability reconciliation. Existence in history is not proof the behavior still
  exists after a revert. Determine current applicability against current source.
- History cursors must survive restarts without missing commits or duplicating jobs.
  No wall-clock timestamp-only cursor; commits can have misleading timestamps.

## 8. Working-tree observations and commit reconciliation

Observe saved filesystem changes, not unsaved editor buffers. Reuse watcher
signals and debounce/coalesce bursts; do not introduce a second recursive watcher
for every MCP client. Poll Git state conservatively when required; never assume
Git metadata paths are normal directories (linked worktrees may use a .git file).

Represent staged and unstaged differences separately, anchored to the observed HEAD
and index state. Include eligible untracked files only under explicit collection
policy. Do not let observation itself create a commit or stage files.

WIP observations are temporary and not completed implementation claims. Bound their
retention and collapse superseded snapshots. When work is committed, link compatible
WIP evidence to committed file changes through content identity. Never correlate
only by time or filename: partial staging, squashing and intervening edits differ.
If HEAD/index/files change during capture, retry within a bound or return an
inconsistent/partial snapshot; do not label a mixed view as atomic.

## 9. Retrieval and memory maintenance

Extend recall through a bounded history section or a dedicated engineering-context
endpoint; retain compatibility with existing recall_context. Inputs may include
task, selected paths/symbols and intent. Scope comes from the selected server project.

Return applicableRules, currentCodeLinks, relevantChanges, documentedIntent,
conflicts, verificationGaps and provenance as distinct sections. Use paths/symbols
and deterministic text search first; embeddings remain optional. Cap bytes, results
and traversal depth; include continuation cursors and omitted-scope reasons.

Treat current applicability as a separately evaluated property:
CURRENT_SUPPORTED / HISTORICAL / RECHECK_REQUIRED / UNKNOWN are suggested values.
Expose how it was determined and when. Historical lessons may remain useful without
being portrayed as implemented in the current branch. Preserve superseded decisions.

A document/code change can enqueue maintenance of linked evidence. Produce proposed
updates, conflicts or archive suggestions; do not silently edit active requirements.
Archiving a source, pruning WIP or disabling collection must have distinct semantics.

## 10. Resource and privacy management

Separate local deterministic collection permission from sending evidence to model
providers. Existing conversation-workflow opt-in must not silently authorize uploading
all repository history. Keep private excerpts out of public tests, logs and reports.
Docs, patches and code are untrusted data, including prompt-injection instructions.
Use exact segment-ID resolution for model output. Do not execute recommendations.

Proposed initial tunable limits (validate before finalizing; these are not measured
capacity guarantees): one heavy ingestion worker across local clients, one AI job
at a time, 100 commits per discovery page, 20 files per analysis batch, 2 MiB per
file, 256 KiB patch payload per analysis unit, and model input within the existing
provider budget. Split/skip with explicit coverage reasons rather than silently
truncating or dropping history. If other jobs need progress, yield between batches.

Stream enumeration and bounded blob reads. Avoid retaining a full repository AST,
all diffs or every Markdown file in memory. Reuse immutable content analysis only
when source kind, policy, parser/model/prompt/schema revision and content identity
all match; preserve original provenance separately. Bound cache size and reclaim it.

Do not raise PostgreSQL connection counts per project by default. Reuse existing
pools where practical and budget total connections/work across clients. Keep model
calls outside database transactions. Persist leases, cancellation and fenced results.
Define retryable versus permanent failure and backpressure; no endless retries.

Provide disk quotas, pending-job counts, bytes read, model input/output usage,
cache hits, queue age, skipped reasons and timing by phase. Measure process peak
RSS separately from PostgreSQL and Docker/VM footprint. Resource profiles must not
silently change global Docker/WSL settings used by unrelated applications.

Retention proposal: keep active memory provenance; bound WIP snapshots and regenerable
analysis caches; support explicit purge of source excerpts and derived artifacts.
If evidence is purged, mark linked records unavailable rather than fabricating it.
Define backup/restore and deletion of segments, jobs and caches before broad adoption.

## 11. Proposed CLI/MCP surface — not currently available

Prefer coherent names after checking existing commands. Suggested capabilities:

- Configure document/history/WIP collection independently per project, with preview.
- Start/resume a bounded collection or history backfill; cancel only owned jobs.
- Inspect status: coverage frontier, active head/worktree, pending/failed jobs and budgets.
- List document revisions, file changes and evidence with pagination.
- Query relevant engineering history for a task/path/symbol.
- Inspect candidate conflicts and explicitly review/promote/supersede.
- Preview retention cleanup; purge only with explicit user authorization.

All CLI operations default to cwd and support --project. All MCP operations reuse
existing project attachment/routing. Add native Windows support and safe argument
handling. Do not present these proposed capabilities as available alpha.28 commands.
Update marker-bounded English instructions in both AGENTS.md and CLAUDE.md on upgrade.

## 12. Delivery slices and exit criteria

| Slice | Deliverable | Required exit evidence |
| --- | --- | --- |
| A | Current-code audit, DTO/lifecycle decisions, additive store contracts | Impact map, migration/rollback-compatible upgrade tests; no completed claims without source evidence |
| B | Deterministic Markdown revisions and Git file-diff ingestion | `fx` commits, coverage frontiers, exact source references, repeat-run idempotency |
| C | Worktree/branch state and WIP reconciliation | Merge/rebase/revert/partial-stage tests; no cross-worktree leakage |
| D | Source-neutral candidates with Spark/Haiku verification | No fabricated user messages; quoted document/diff evidence resolves exactly; no auto-promotion |
| E | Bounded unified retrieval and linked-evidence maintenance | New-session task retrieves relevant rules/history and flags obsolete implementation |
| F | Resource profiles, retention, diagnostics and installer integration | Comparative measurements, interruption recovery, project-scoped configuration preservation |
| G | Real repository acceptance and release preparation | Published evidence for tested cases, disclosed gaps, platform gates; release only when separately authorized |

Deliver in reviewable slices; do not claim B completes the whole plan. Keep other
existing roadmap items intact. Do not replace all current memory tables solely to
fit this proposal. Document necessary deviations and preserve compatibility.

## 13. Mandatory acceptance matrix

- A commit named `fx` changes a refund function: find exact old/new code and affected
  path without inventing rationale; retrieve it by refund task/path.
- A Markdown rule changes: return old/new evidence and a reviewable replacement;
  merely moving the paragraph must not create a duplicate or revoke the rule.
- A plan says a feature is planned while code lacks it: do not claim implemented.
- Assistant summaries, misleading commit messages and malicious Markdown cannot
  become user statements, execute tools or bypass review.
- One decision links to a service, its callers, Prisma schema and tests; report
  unsupported or unresolved links rather than assuming they are valid.
- Branch A contains a change absent from B; switching to B does not claim it exists.
- Reverting code preserves historical evidence but flags current applicability.
- Merge, cherry-pick and rebase avoid duplicate logical candidates while retaining
  distinct commits/comparison parents and sources.
- Partial staging and commit reconciliation do not lose unstaged edits or count
  the same content as independent corroboration.
- Initial commit, detached/unborn HEAD, non-Git directory, shallow clone and missing
  Git object have explicit supported/partial/unavailable results.
- Case-only rename, path with spaces/newlines, symlink escape, submodule and linked
  worktree are handled safely on applicable platforms. Submodule content requires
  separate authorized project scope, not implicit recursion.
- Oversize/binary/generated/ignored material remains visible in coverage summaries.
- Unicode evidence is exact; model-selected unknown/repeated IDs are rejected.
- Restart, lease loss, simultaneous clients and interrupted backfill do not duplicate
  records, publish stale results or leak another project's evidence.
- Provider offline/quota/schema failure leaves deterministic queries usable and
  provides actionable non-sensitive diagnostics.
- Backup/restore preserves IDs and scoped provenance; purge removes selected source
  data and derivatives consistently, exposing remaining verification gaps.

Use disposable synthetic Git repositories and databases for automated tests. For
real kiosk acceptance, use the user's explicitly selected checkout, collect no
private source in this public repository, and do not mutate its worktree or history.
Measure first collection, incremental update, no-op rescan, retrieval p50/p95, bytes
read, peak process RSS, DB footprint, model usage and restart recovery. Compare the
same fixture, policies and workloads before/after; do not promise universal timing.

## 14. Ready-to-use instruction for Claude Code

Implement this plan in the existing repository, in slices A through F, then perform
slice G acceptance where the required environment is available. Start by reading
current AGENTS.md/CLAUDE.md, README, implementation status and limitations, and verify
the actual source contracts. Use available project MCP tools and source fallback
honestly; do not assume the alpha.28 graph covers subsequent edits.

Preserve existing code, project isolation, conversation protocol compatibility,
provider opt-in and explicit memory approval. Use file-level diffs as the primary
history evidence even when commit messages are `fx`. Do not fabricate user-message
roles for documents. Keep proposed endpoints/limits distinguishable from existing
ones until implemented and tested. Do not create source-derived active rules silently.

For each slice, report changed files, migrations/API changes, exact tests run,
verified acceptance cases, remaining limits and the next slice. Pause only for a
material product choice or unavailable required environment; do not silently drop
scope. Do not commit, push, tag or publish as part of this handoff unless the user
separately authorizes it. Do not automatically enable providers or ingest unrelated
projects. Keep user-facing product instructions and generated material in English.

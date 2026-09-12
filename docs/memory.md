# Explicit project memory

Supported types: FACT, DECISION, WARNING, NOTE, CONVENTION, INCIDENT, TODO.
Scopes are repository, directory, file and symbol; global scope is rejected.
Content is explicitly supplied, not inferred from code or automatically created.

`remember` creates a record. `supersedes` transactionally replaces an ACTIVE
same-project record and links it to the new one; the old record remains
SUPERSEDED. Concurrent replacements of the same record allow only one winner.
CLI `memories --archive <id>` archives a same-project record. Search defaults to
ACTIVE records; `includeInactive` also returns ARCHIVED and SUPERSEDED history.

## Filters and pages

`search_memory` accepts these fields in addition to the optional literal `query`:

- `types`: match any of the selected types; empty means every type.
- `tags`: require all selected tags, with exact case-sensitive matching.
- `scope`: `{type, target?}`; omitted target filters by scope type alone. A target
  matches that exact scope identity, not descendant paths or inherited scopes.
  Repository scope never accepts a target.
- `includeInactive`: false by default.
- `limit`: 1–100 (default 20); `offset`: 0–100000 (default 0).

Filters combine with AND. Text search remains a case-insensitive literal
substring of title, content and space-separated tags. Percent, underscore and
backslash characters are literal. Newest creation time sorts first, with ID as a
stable tie-breaker. Priority is stored but does not alter this ordering.

SQL selects at most `limit + 1` records and returns `results`, `hasMore` and
`nextOffset`. Search works before code indexing and never loads a full memory
or code snapshot. A five-second SQL timeout bounds database work; broad text
queries may still scan many scoped records. Separate pages can shift when
memories are created or archived between requests; there is no cursor snapshot.

## Scope lifecycle

New file/directory memories require an existing target of the correct type,
inside the selected project and outside excluded source boundaries. Paths are
stored relative to the canonical project root (`.` for the root directory).
Symbol existence is checked with a scoped row lock in the insert transaction;
foreign or missing symbol IDs are rejected. Code deletion later does not delete
these memories or automatically reattach them to a renamed symbol.

Search filters check path boundaries lexically without reading source files, so
memories remain searchable after deletion. Use the stored canonical target for
symlink aliases. Older records retain their original target text: canonical,
absolute, `./` and the exact supplied legacy spelling are accepted when
filtering. Other historical spellings may require supplying their stored value.
No migration rewrites memory content or scope identities.

`clean --yes` deletes only code index data; memory survives. `remove --yes`
removes the selected project and its memories. These operations remain scoped.

## CLI examples

```sh
bun run dev remember --project /absolute/project --type WARNING \
  --title 'API rule' --content 'Keep this response compatible.' \
  --scope file --target src/api.ts --tag api --tag compatibility

bun run dev memories --project /absolute/project --type WARNING --type DECISION \
  --tag api --scope file --target src/api.ts --limit 10 --offset 0

bun run dev remember --project /absolute/project --title 'Updated rule' \
  --content 'Replacement guidance.' --supersedes MEMORY_ID

bun run dev memories --project /absolute/project --include-inactive
```

Migration 3 adds memory filter/paging indexes. Run `bun run db:migrate` when
upgrading. Index creation can lock busy tables; choose an appropriate maintenance
window. Existing records are preserved and migration reruns are idempotent.

## Evidence-backed workflow

The optional workflow now connects MCP clients to a durable review queue. It does
not read chat logs automatically and never promotes inferred memory automatically.
Generated client instructions require task-start recall and task-end assessment.
Both AGENTS.md and CLAUDE.md receive the same marker-bounded instructions during
project installation and upgrade. All prompts and generated protocol content are
English; supporting quotes preserve the original language.

From the project directory, after installing and signing in to current Codex and
Claude CLIs:

```sh
codememory memory configure --enable --yes
codememory memory status
codememory memory candidates
codememory memory candidates --job JOB_ID
codememory memory review JOB_ID CANDIDATE_ID --approve --yes --reason "I approve the displayed rule."
codememory memory recall "refund validation" --path src/refunds.ts
```

The configure command applies additive database migrations and records per-project
consent to send selected excerpts to the model providers. It does not install
model CLIs, purchase credits, or grant automatic promotion. Use `--disable` instead
of `--enable --yes` to stop new submissions and further processing. An already
submitted model request cannot be recalled from its provider.

MCP exposes `recall_context`, `memory_workflow_status`, `submit_memory_batch`,
`list_memory_candidates`, and `review_memory_candidate`. Project selection uses
the same exact root/scope ID as code queries. A live MCP connection processes
queued work every three seconds. Without a client connection, run:

```sh
codememory memory worker
# Or process at most one job:
codememory memory worker --once
# Explicit recovery after checking diagnostics:
codememory memory retry JOB_ID
```

Multiple clients sharing one database use one global PostgreSQL worker lock.
No long database transaction remains open during inference. Abrupt process death
releases the connection lock; a subsequent worker recovers its RUNNING job.
FAILED jobs require explicit retry and have at most three attempts. Ctrl+C stops
the foreground worker and its owned model process. Status and candidate commands
are read-only; submitting, reviewing and retrying are distinct operations.

Codex extraction requests `gpt-5.3-codex-spark`; verification pins
`claude-haiku-4-5-20251001`. Each process has a 120-second timeout and a 2 MiB
combined output limit. Verifier telemetry outside the allowlist fails the job.
Codex may omit actual-model telemetry: metrics report `reportedModel: null` and
`modelVerified: false`, never a false verification claim. CLI versions must support
the isolation flags; older versions fail with a diagnostic rather than silently
using a weaker invocation. Windows native executables and standard npm package
layouts are resolved without passing evidence through a command shell.

An exact quote and a positive model verdict are necessary but not sufficient for
promotion. The host checks unique IDs, complete reviews, original evidence,
classification, user authorship and review eligibility. Classification failures
get at most one extraction correction followed by another verification. Other
rejections remain review data. A repeated approval returns the same memory; exact
active duplicates reuse a record. Semantic merging is never automatic.

Recall uses repository rules and matching directory ancestors, files and symbols,
ordered by scope specificity, task text relevance, priority and recency. It returns
at most ten records with a 6000-character combined content budget. It discloses
truncation and does not assert that stored code-dependent claims are current.
The first workflow version promotes repository-scoped rules; explicit `remember`
continues to support directory/file/symbol scopes. Automatic rename reconciliation,
full-chat imports and automatic semantic conflict resolution are not implemented.
Job evidence remains in the local database until project removal; do not submit
material that should not be retained. `clean` retains memory and jobs; `remove`
deletes the selected project's memories, jobs and workflow configuration.

See [the AI protocol](specifications/memory-agent-protocol.md) and
[the lifecycle design](specifications/memory-lifecycle.md) for the contract and
planned extensions. Model agreement is not proof of truth. Review the actual
claim before approving it; never use these records as authority to override the
current user or system instructions.

# Document and Git history memory

Available starting with alpha.29. Update the shared CLI and reconnect MCP before
using these commands. Collection and model processing remain opt-in per project.

| Information | Source | Authority |
| --- | --- | --- |
| Current code graph | JS, TS and Prisma analysis | Static implementation evidence with coverage limits |
| Engineering history | Actual file changes and saved worktree bytes | Observations; commit messages such as fx are optional metadata |
| Documented intent | Exact Markdown sections and revisions | Attributed material, including proposals and outdated plans |
| Active memory | Explicitly reviewed candidate or user-supplied rule | Approved context; source changes do not silently revoke it |

## Project setup

Commands default to the current directory; --project selects another root. On
Windows use codememory.cmd with the same arguments.

    codememory history configure --documents --git
    codememory history configure --documents --git --yes
    codememory history scan --all
    codememory history status

The first command previews settings. Applying configuration prepares the additive
schema. Sources default to disabled. Settings persist per canonical project root
in the existing PostgreSQL service and survive installer upgrades.

    codememory history configure --wip --yes
    codememory history configure --automatic --yes

WIP includes saved staged, unstaged and eligible untracked files. Automatic mode
collects while an MCP connection is open. There is no additional database,
container or recursive watcher per client. Collection never stages files, executes
repository programs, fetches history or reads unsaved editor buffers.

Scanning follows protected paths, symlinks, nested repositories, configured
include/exclude, .gitignore and .codememoryignore. Both generated instruction
marker blocks are excluded from Markdown evidence. Historical collection applies
the current checkout's exclusion policy.

## Progress and scope

    codememory history scan --job JOB_ID --all --batch-size 20
    codememory history job JOB_ID
    codememory history list jobs
    codememory history retry FAILED_JOB_ID
    codememory history cancel JOB_ID

A scan processes one bounded batch unless --all is supplied. Progress goes to
stderr and JSON to stdout. Ctrl-C preserves the durable cursor. Jobs capture HEAD,
worktree identity and policy generation; merge parent comparisons remain distinct.
Previously covered reachable history can be reused on incremental collection.

Read gapCount, gaps, exclusions and per-source status. A completed local traversal
does not mean unavailable shallow ancestors or excluded files were analyzed.
Working-tree capture is non-atomic: HEAD/index/path changes produce explicit gaps
and each file read is validated. Resolved WIP is not proof that a particular commit
implemented a rule. Git clean filters are never executed, so raw-byte differences
may include CRLF/filter normalization without implying a semantic change.

## Query evidence

    codememory history list changes --path src/refund.ts
    codememory history list documents
    codememory history list wip
    codememory history context "refund implementation" --path src/refund.ts
    codememory history list segments --revision REVISION_ID
    codememory history evidence SEGMENT_ID

Follow hasMore and nextOffset. Changes carry old/new paths, objects, parent,
bounded hunks and affected syntax locators. Prisma uses the existing comment-aware
parser. Resolve runtime usage, aliases and callers through the current code graph;
a locator or test file never proves test execution.

Current reachability and byte matches are separate. CURRENT_BYTES_MATCH describes
bytes only; reverted or other-branch code remains historical. Markdown structure,
duplicate headings and exact UTF-8 byte/line ranges are retained. Original Turkish
evidence is not translated; generated claims and provider instructions are English.

## Reviewed document rules

Model transmission requires a separate opt-in. Conversation-memory enablement
does not enable history providers, and collection alone sends no source to AI.

    codememory history configure --providers --yes
    codememory history submit stable-batch SEGMENT_ID OTHER_SEGMENT_ID
    codememory history worker
    codememory history job JOB_ID --limit 1 --offset 0

The extractor selects server-provided handles; exact segments are resolved before
independent verification. Documents and commits are never fabricated as user
messages. Code supports observations, not permanent policy. Supported, explicit
documented requirements/decisions become candidates and need human review.

    codememory history review JOB_ID CANDIDATE_ID --approve --yes --reason "I approve this exact rule."

Use --reject to reject. Replacement additionally requires --supersedes ID.
Retries reuse the original batch ID/evidence. Exact duplicate active claims reuse
a memory; semantic similarity cannot silently merge rules. Approved memories retain
source-segment links. Recall reports changed/missing evidence separately from rule
validity. Authorized checkpoints attach implementation, callers, Prisma and tests.

MCP tools: history_status, search_history, get_history_job, get_history_evidence,
engineering_context, collect_history, submit_history_candidates,
review_history_candidate. They reuse existing project routing. Use only tools
actually exposed by the connected runtime. Configuration and destructive
maintenance are CLI actions. Failed providers retain safe diagnostic codes;
explicit retries are capped at three attempts, without silent model fallback.

## Resource controls and recovery

Defaults: 20 files/batch, 2 MiB/source, 256 MiB stored excerpts, 30-day WIP retention,
16,000-byte submitted evidence and one history batch across clients sharing the
database. Git metadata has an 8 MiB output cap and 15-second deadline. Limits are
not performance promises. Model calls do not hold database transactions.

    codememory history configure --max-file-bytes 1048576 --retention-days 14 --yes
    codememory history cleanup
    codememory history cleanup --yes
    codememory history cleanup --purge
    codememory history cleanup --purge --yes

Cleanup previews by default. Purge removes excerpts and source-derived job payloads,
retaining source identities and active memories. Purged evidence is unavailable;
a no-op rescan does not silently reconstruct it. Disable sources separately using
--no-documents, --no-git, --no-wip, --no-providers or --no-automatic.
The excerpt budget excludes metadata, database indexes/WAL and Docker VM RAM.
No global Docker or WSL settings are changed.

Backups contain private evidence: save outside version-controlled source or under
the protected .codememory directory, and never publish them.

    codememory history backup /private/location/history.jsonl
    codememory history restore /private/location/history.jsonl --yes

Backup streams a consistent database snapshot and refuses existing output files.
Restore verifies scope, format and checksum transactionally. It requires empty
history/memory for the same canonical project. Only memories linked to history
are included; normal PostgreSQL backups are needed for all code indexes and
conversation memories. Restored collection/providers remain disabled and queued
jobs cancelled. A different project root is not implicitly authorized.

## Verification boundary

Synthetic tests cover exact evidence, fx diffs, changed documents, partial staging,
merges, unusual names, Prisma, provider protocol failures, explicit approval, scope
isolation, CLI cwd defaults and corrupted-backup rollback. Consult the verification
report for actual command results. These checks do not certify all dynamic
relationships, arbitrary Markdown semantics, provider quotas or Windows and
large-repository performance.

Starting with alpha.30, [API provider profiles](api-providers.md) can replace the
default CLI models while retaining history permissions and review.

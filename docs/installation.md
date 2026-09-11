
## Management CLI and restart recovery

An applied installer installs a user-local `codememory` launcher **before** preparing Docker, WSL or PostgreSQL. Its absolute path is printed even when a reboot interrupts service setup. Add the printed `bin` directory to your user PATH once; alternatively invoke the full path (PowerShell: `& 'C:\path\to\codememory.cmd' system status`). The CLI still requires the installed Bun runtime. It never edits global MCP settings.

```sh
codememory system status
codememory projects list
codememory system setup --project /absolute/project
codememory system restart --project /absolute/project
codememory projects add /absolute/another-project --client both --no-index
codememory projects remove /absolute/another-project --yes
codememory updates
```

`system status` and `projects list` work before database installation. `system setup` resumes a pending managed registration, prepares services, reapplies its project configuration and indexes **only** the selected project. `system start` uses the same health-checked setup path. `system restart` recreates the owned PostgreSQL container while retaining its volume and credentials; other active MCP connections may need reconnecting. Omitting `--project` only manages services and does not index registered projects.

`projects add [path]` defaults to the current working directory when no path is supplied; it never expands to a parent Git root. For example, run `codememory projects add --client both` inside the project. `codememory index` and `projects remove --yes` also accept the current directory.

`projects add` installs the selected client's project configuration and indexes immediately. Use `--no-index` to defer indexing, or `--external-db` to use your own `DATABASE_URL`. A failed index leaves the registration available for retry. `projects remove --yes` disables future MCP sessions without deleting source files, client settings, database indexes or memories. Close existing sessions first; re-adding the project enables it. The older `remove --project ... --yes` command is a separate destructive database purge.

Registrations are local to the operating-system user and stored outside repositories. Reinstalling the CLI replaces its launcher; existing project connections retain their configured runtime until explicitly updated. Use the bootstrap upgrade commands in [README](../README.md#update-an-existing-installation) to explicitly retarget a compatible same-project entry with backups. Unrecognized/custom entries and database-mode changes are refused.

## Update notifications

`codememory updates` checks the fixed public GitHub releases endpoint. MCP `codebase_status` includes the same `updates` information, cached for 24 hours per server process. Alpha installations include alpha releases; stable installations stay on stable releases. Requests contain no project root, source, database URL or stored memory. Network failures report `unavailable` and do not block indexing. Set `CODEMEMORY_UPDATE_CHECK=0` in the MCP process environment to disable checks.

When a newer release is reported, the client instructions ask the AI to notify you and request your approval. This is an instruction to the assistant, not an enforced notification UI or a background scheduler: the client must call `codebase_status`. No files are downloaded or updates applied automatically. After approval, follow the release's installation instructions and review any existing project configuration conflicts before switching runtime paths.

## Live indexing progress

```sh
codememory index
codememory status
codememory status --watch
codememory status --watch --json
codememory index --no-progress
```

`index` shows scanned-file counts and relative file names, parser phases and
processed-file counts, publication, completion/failure and elapsed command time.
Terminal output updates in place at a bounded rate; redirected stderr gets plain,
less frequent lines. File names are sampled rather than printing every file.
Synchronous compiler operations can delay foreground refreshes. No percentage or
ETA is invented for discovery, compiler setup or database publication.

Progress goes to stderr; the final index result stays JSON on stdout.
`--no-progress` suppresses the live display. Project-add and selected-project
service recovery also show index progress.

`status` retains its JSON response. In another terminal, `status --watch` follows
the last durable job's stage/state every two seconds until Ctrl+C. It does not
start an index or register a project. Its file/symbol/relationship totals describe
the last published index, not partially written data. Per-file live progress is
local to the indexing command; status watches persisted stage boundaries.
`--watch --json` emits one JSON object per line for monitoring scripts.


## Coverage and diagnostics

A published graph can be `READY` and `incomplete: true`. Valid files remain
queryable. Do not trust all relationships from a file listed in syntax diagnostics;
inspect or fix its source first. Syntax diagnostics have `kind: SYNTAX_ERROR`,
a TypeScript `code`, and one-based `line`/`column`. Configuration diagnostics
use `CONFIGURATION`; unavailable locations are omitted rather than guessed.

`diagnosticSummary` gives total messages, affected files, page limit/offset,
`hasMore` and `nextOffset`. `last_run.diagnostics` contains only that page
(default 10, maximum 20), not the full historical array. Pass `diagnosticLimit`
and `diagnosticOffset` to MCP `codebase_status`, or the corresponding kebab-case
flags to CLI `status`. `incompleteReasons` separates syntax/configuration issues,
oversized/binary/unreadable source files and an unindexed repository. Each reason
includes at most 20 sample paths and an explicit `hasMoreFiles` marker. These
samples are not an exhaustive path inventory. `fileErrors` remains the first
20 file read failures; an empty array does not imply no parser errors.

`excludedEntries` (legacy MCP alias `excludedFiles`) counts encountered excluded
entries, not every descendant under pruned directories. `exclusions` splits files,
directories and other entries by reason: protected paths, symlinks, project excludes,
gitignore rules, nested repositories, include filters, generated files and size/binary
limits. A directory counts once and is not traversed to count its children. Counts
are not a whole-disk inventory; unrelated unsupported file types are not counted.
Intentional exclusions alone do not make the graph incomplete. Old generations
report `exclusions.available: false` until rebuilt; missing legacy locations are
not reconstructed. Parser revision 6 triggers that rebuild on the next index.

Only JavaScript/TypeScript source extensions listed in `analysisScope` are analyzed.
Kotlin and Prisma are unsupported; `NOT_FOUND` from their source queries is not
evidence of absence on disk. JSON project metadata may aid module resolution but
does not receive a source-language graph. `unresolvedReferences` counts recorded
unresolved usages; zero is not proof that every dynamic call is understood.

To intentionally exclude temporary scripts, merge this field with existing
`.codememory/config.json` settings:

```json
{ "exclude": [".workflow-tmp/**"] }
```

Preserve any existing exclude patterns. Restart the project's MCP connection so it
loads the new configuration, or run `codememory index` from that project directory.
Do not exclude application sources merely to hide syntax errors.

### Preview and page completeness

`get_symbol` previews at most 16 lines / 4,000 characters. Check `snippetTruncated`,
`returnedStartLine`, `returnedEndLine`, `returnedEndLinePartial` and `continuation`.
Follow `get_file_context` until the symbol's declared end line; that tool also
reports character truncation and continuation. An oversized single line may
require reading local source. These response limits are separate from the index's
`incomplete` coverage flag.

Oversized MCP `results` pages are reduced in the same snapshot; follow the returned
`nextOffset`, never the originally requested page size. `pageSizeReduced` and
`returnedLimit` explain the reduction. If even one record or non-page response is
too large, `RESPONSE_TOO_LARGE` includes `suggestedLimit: 1` and
`responseTruncated: true`; it does not change the graph's coverage flag.

### Running versions and stale clients

`runtime` identifies the responding process by version, PID, start time and session.
`lastIndexJob.owner` identifies the index writer, while `databaseBackendPid`
and `lockActive` describe its PostgreSQL lock. Older job records may lack owner
metadata. PIDs are local to their host and may be reused; they are not kill tokens.

PostgreSQL serializes same-project writers; different projects have independent
locks. `INDEX_BUSY` does not establish that an old process caused another error.
Close/reconnect the relevant Codex/Claude project connection after an upgrade,
then verify `runtime.version`. An old running process continues its loaded code
until its client disconnects. Installers verify the new executable/entry paths
before rewriting settings and preserve old release folders for rollback.
There is no automatic process killer, global daemon or release-directory garbage
collector. `projects remove --yes` disables a registry entry; it does not uninstall
client settings, kill clients or delete source/database data.

CLI/MCP public failures include `diagnosticId`; find the matching
`operation_failed` event in CLI stderr or the client's MCP server log. It records
the public error code and runtime identity, not arbitrary exception text or
credentials. Keep the command, project status and matching event when reporting
an issue. Full private exception dumps are not automatically persisted.

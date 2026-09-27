# Indexing

Discovery prunes excluded trees before reading. Source files are bounded to 2 MiB by default, checked for NUL bytes, hashed with SHA-256 and tagged for generated code. The TypeScript plugin analyzes accepted files using a bounded compiler input map, configured workspace mounts and in-scope reference redirects. See parser.md for configuration ownership and declaration-output mapping. Unresolved references are persisted separately.

The index fingerprint combines parser version, schema compatibility, source-selection config and in-scope tsconfig/package/gitignore text. Reconciliation first reads a compact file hash/status manifest, without loading the graph. A no-op reopen skips all parser and graph writes; operational progress metadata is updated. Otherwise the selected project is conservatively re-analyzed for dependency correctness. Publication hashes each file's semantic records and replaces only relationships whose file hash changed; cross-file effects are included when their semantic records change. File changes and deletion cleanup publish atomically with graph data and an index-run record. Parser diagnostics are returned as incomplete coverage; fatal failures retain the previous graph.

Configuration lives in `.codememory/config.json`. `init` writes documented defaults without replacing an existing config. Supported keys: `maxFileSizeBytes`, `parserTimeoutMs`, `parserOutputLimitMiB`, `include`, `exclude`, `excludeGenerated`, `debounceMs`, `reconcileMs`. Unknown keys fail validation. Restart the process after config changes.

The watcher reacts to filesystem events after the 300 ms debounce. Its fallback reconciliation scan defaults to every five minutes, reducing idle disk and CPU work in large repositories. A change to `debounceMs`, `reconcileMs` or parser timeout/output limits does not change source analysis and therefore does not invalidate the graph fingerprint. Source selection or parser changes still trigger a full safe reanalysis.

On macOS, the watcher uses the native recursive filesystem subscription and applies the project's exclusion rules to received paths. This avoids a synchronous directory crawl when the MCP connection opens. Other platforms use Chokidar with cached ignore rules. Coalesced or nameless events still trigger a project reconciliation scan; the periodic scan covers missed events.

Published file, symbol and relationship totals are recorded with each index run. Status requests read those totals instead of recounting large tables; older generations without saved totals use the original count queries until their next successful index.

Recoverable source read failures are recorded per file and retried on the next index. Durable stage/owner records expose abandoned attempts without deleting the last completed graph. See [hardening](hardening.md).

`parserTimeoutMs` defaults to 120000 and accepts integer milliseconds from 1000 to 600000. This bounds the isolated parser subprocess; it does not change the output cap or SQL query limits. Increase it only when a larger selected project requires a longer analysis window.

The isolated parser transfers newline-delimited records instead of buffering one giant JSON document. `parserOutputLimitMiB` defaults to 1024 and accepts integers from 1 to 8192. It bounds total transferred bytes, not process RAM: the compiler and resulting graph still require memory proportional to the project. Individual incomplete records are bounded to 64 MiB. A truncated stream is never published as a completed index.

To profile a selected repository without writing to its source tree or application database, run `bun run profile:project --project /absolute/root --query Symbol` from the CodeMemory checkout. This uses a fresh disposable CodeMemory test database at `TEST_DATABASE_URL` (or the development Compose database on port 55432), reports scan, analysis, publication, query and second-pass times, then drops the test database. Add `--force-second` to measure semantic reanalysis and selective publication even when source files do not change. Parent and parser peak RSS are sampled separately; the container has separate memory use. Do not use a production database as the test server.

For larger projects, merge these settings into `.codememory/config.json`, then restart the MCP session:

```json
{
  "parserTimeoutMs": 600000,
  "parserOutputLimitMiB": 2048
}
```

`codebase_status.error` retains the stable error code. `errorMessage` includes the isolated parser's safe diagnostic (output limit, deadline, failed exit or malformed stream) without echoing worker stderr or source content. It clears after a successful retry. These settings require a release containing the streaming parser; alpha.13/alpha.14 reject the new configuration key.

## Temporary workflow reports

From alpha.23, directories named `.workflow-tmp` are excluded at every depth by
the shared protected-path policy, alongside existing `.tmp` and `.cache` paths.
They are not scanned, watched or available through direct source reads. Their
exclusion contributes to `PROTECTED_PATH` counts, not `incompleteReasons`.
Normal source names such as `src/report.ts` or `src/workflow-tmp.ts` remain eligible.

After updating, reconnect the project's MCP session and let indexing finish.
Previously indexed temporary files are removed during normal reconciliation;
source files on disk are not deleted. Other custom scratch directories can be
excluded using the `exclude` list in `.codememory/config.json`. Merge entries into
existing settings rather than replacing the file.

## Project-wide ignore policy

Use a root `.codememoryignore` to share indexing-only exclusions without changing
Git tracking. It uses gitignore syntax: one pattern per line, `#` comments,
`**` wildcards and `!` negation within this file. Nested `.codememoryignore` files
are not loaded. For example:

```gitignore
# Choose the actual scratch/output paths used by your project.
/analysis-output/
**/*.report.mjs
# Retain a real source file otherwise matched above.
!src/business.report.mjs
```

The policy applies to initial indexing, reindexing and watcher pruning. The file
is included in the index configuration fingerprint, so editing or deleting it
is picked up by the next scan. Removed index entries are reconciled; source files
remain on disk. Exclusions are reported as `CODEMEMORYIGNORE` and do not themselves
make coverage incomplete. The ignore file is read only when at most 64 KiB.

Layers reject independently: protected paths/symlinks, JSON `exclude`, hierarchical
`.gitignore`, and the root `.codememoryignore`. A negation only cancels an earlier
match within its own ignore file; it cannot override another layer. An excluded
parent directory is not visited, so re-including a child also requires keeping its
parent traversable. Existing source-query operations remain bounded by indexed
files; the shared hard path rules also apply to direct safe-path access.

Use `include` for a deliberately narrow scope and `excludeGenerated: true` to
exclude detected generated sources (path conventions or generation markers).
Generated-source exclusion is opt-in because generated declarations can carry
useful relationships. Tests, fixtures and files named `report` are not generally
irrelevant and remain eligible by default. No semantic classifier silently decides
that source code is unrelated to your project.

This layered approach is comparable to upstream
[codebase-memory-mcp's documented ignore policy](https://github.com/DeusData/codebase-memory-mcp/blob/9b85dd3eafcbfd0e2106fed3ad025de3910c0a5b/docs/cbmignore.md).
CodeMemory does not implement that project's fast-mode exclusions, global Git
ignore configuration or cross-layer negation overrides.

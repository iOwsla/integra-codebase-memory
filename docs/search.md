# Search and bounded index reads

CLI and MCP index queries use the `ProjectStore.readIndex` port. PostgreSQL owns
one read-only REPEATABLE READ transaction per request, including readiness,
generation, diagnostic status and result data. Concurrent publication cannot mix
generations within a response. The reader closes when its callback ends. Full
snapshots remain available for inspection/offline utilities; reconciliation uses
a compact file manifest.

Symbol ranking uses exact name (100), exact qualified name (95), name prefix
(80), name substring (65), then PostgreSQL `pg_trgm` similarity at threshold
0.3 (50 × similarity). Import/export aliases receive a 0.6 multiplier and
generated files a 0.5 multiplier. This replaces the earlier JavaScript trigram
approximation; fuzzy scores and candidate membership can change. Results carry
their score and reason. Kind filters apply before paging.

Code search is a case-insensitive literal substring search over indexed lines.
`%`, `_` and backslashes are escaped, not treated as SQL patterns. It uses a
content trigram index to select candidate files, then returns matching line
numbers and snippets of at most 500 characters. It is not regex or token-based
full-text search. Short/common queries can still scan many records server-side.

Paged reads fetch at most `limit + 1` rows, with `limit` 1–100 and `offset`
0–100000. Ordering includes deterministic file/line/ID ties. `hasMore` describes
the extra row; `nextOffset` advances by the requested limit. Across separate
requests, indexing can change the result set: compare `indexVersion` and restart
paging when it changes. There is no persistent pagination snapshot or cursor.

Symbol selection fetches at most 21 candidates and reports at most 20 ambiguous
declarations. File outlines are paged, symbol snippets are capped at 4,000
characters and file context at 12,000 characters. Context accepts at most 50
lines before/after the requested line; a line beyond the indexed file returns
`INVALID_RANGE`. Existing path boundary checks run before opening the transaction.

Each SQL statement has a five-second timeout, mapped to `QUERY_TIMEOUT` with
transaction rollback. Output limits do not imply constant database CPU cost.
The separate MCP response-byte cap still applies. Pure snapshot utilities in
the search/graph packages are retained for offline use; they are not used by
the production query facade.

## Database upgrade

Run `bun run db:migrate` before using the updated release. Migration 2 adds
lowercase search, diagnostic lookup and directed edge indexes without changing
existing file/symbol/edge data. It can lock tables while creating indexes; apply
it during a maintenance window for a busy database. Migration 1 is unchanged,
and rerunning migrations is idempotent. PostgreSQL remains a local dependency;
starting MCP never silently migrates it.

`tests/integration/queries.test.ts` covers every indexed tool without snapshot
loading, generation consistency during publication, stable paging, literal
characters, project boundaries, traversal limits, read timeouts and upgrades.

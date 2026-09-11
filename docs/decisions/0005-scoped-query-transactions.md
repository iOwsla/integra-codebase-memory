# ADR 0005: Bounded SQL reads per completed generation

Status: accepted.

Previously every index tool loaded a complete project snapshot, including file
contents and unrelated edges, before applying output limits in JavaScript. This
made query memory depend on project size and wasted transfers for small pages.

Add a domain `IndexReader` exposed only through `ProjectStore.readIndex`.
Application adapters retain schema validation and path canonicalization. The
PostgreSQL adapter supplies a context-bound reader inside one read-only
REPEATABLE READ transaction. Metadata and all selected rows therefore reflect
one completed generation even when another connection publishes a new index.
The reader cannot be reused after the transaction ends.

SQL handles ranking, paging, snippets and relationship joins. Graph traversal
fetches bounded adjacency lists and caches them within the request. A recursive
query with unbounded intermediate paths is avoided. Explicit limits and timeout
errors preserve honest partial-result behavior.

Tradeoffs: pg_trgm fuzzy scores differ from the old JavaScript approximation;
offsets are stable only within the same generation; high-selectivity indexes
cannot make every short/common query cheap. Indexing itself still requires a
full scoped snapshot. Memory reads will be addressed separately in Phase 6.

Migration 2 adds indexes without rewriting user or indexed data. Tests exercise
concurrent publication during a read, upgrade idempotence, a blocked query,
foreign project IDs, literal wildcard characters and wide/cyclic graphs.

Update in alpha.5: index reconciliation also stopped reading full snapshots;
it now reads only file path/hash/status and generation metadata. Full snapshots
remain an inspection/offline utility.

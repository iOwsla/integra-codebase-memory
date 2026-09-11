# Graph

A symbol has a deterministic repository-root/file/kind/qualified-name identity. Edges are directed and carry confidence and resolution method. `CALLS` and reference targets use TypeScript semantic resolution; `DECLARES` and direct declaration exports are AST-confirmed. Imports, re-exports, extends and implements are supported. Dynamic or external targets are recorded as unresolved, never guessed.

`get_symbol`, callers/callees and references accept IDs. Names with multiple declarations produce `AMBIGUOUS_SYMBOL` candidates. Import/export aliases have separate identities and rank below actual definitions. Traversal has depth, path and expansion bounds plus cycle detection.

Relationship pages join only scoped neighboring symbols in SQL. Traversal uses
cached, directed SQL adjacency reads rather than loading every edge. It returns
ID paths, deduplicates repeated call sites to the same neighbor and prevents
revisiting a symbol within a path. Requested depth is at most 10 and paths at
most 100. Internal bounds are 128 adjacency queries, 1,000 neighbors per query,
10,000 fetched neighbors, 1,000 queued paths, 10,000 expansion steps and a
five-second loop budget (checked between SQL calls). A statement itself has a
five-second timeout. Exhausted internal bounds or unreturned queued paths set
`truncated: true`; requested depth is the traversal boundary, not a claim that
the path ends in a leaf. See `search.md` for generation and paging semantics.

Anonymous and block-local identities include a source offset and may change after edits that move their position. Named function overloads share an identity and retain the complete declaration range. Getter and setter identities are distinct. Exhaustive framework routes, events, database tables and Cypher are not exposed in v0.1.

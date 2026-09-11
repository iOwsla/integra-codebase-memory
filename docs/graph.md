# Graph

A symbol has a deterministic repository-root/file/kind/qualified-name identity. Edges are directed and carry confidence and resolution method. `CALLS` and reference targets use TypeScript semantic resolution; `DECLARES` and direct declaration exports are AST-confirmed. Imports, re-exports, extends and implements are supported. Dynamic or external targets are recorded as unresolved, never guessed.

`get_symbol`, callers/callees and references accept IDs. Names with multiple declarations produce `AMBIGUOUS_SYMBOL` candidates. Import/export aliases have separate identities and rank below actual definitions. Traversal has depth, path and expansion bounds plus cycle detection.

Anonymous and block-local identities include a source offset and may change after edits that move their position. Named function overloads share an identity. Exhaustive framework routes, events, database tables and Cypher are not exposed in v0.1.

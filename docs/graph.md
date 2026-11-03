# Graph

A symbol has a deterministic repository-root/file/kind/qualified-name identity. Edges are directed and carry confidence and resolution method. `CALLS` and reference targets use TypeScript semantic resolution; `DECLARES` and direct declaration exports are AST-confirmed. Imports, re-exports, extends and implements are supported. Dynamic or external targets are recorded as unresolved, never guessed.

`get_symbol`, callers/callees and references accept IDs. Names with multiple declarations produce `AMBIGUOUS_SYMBOL` candidates. Import/export aliases have separate identities and rank below actual definitions. Traversal has depth, path and expansion bounds plus cycle detection.

`find_callers` on an instance member also returns calls whose static receiver type is an interface or base class the member implements or overrides. The owning class's `IMPLEMENTS`/`EXTENDS` ancestors are followed up to depth 10 and matched by member name. Those rows carry `dispatch.via` with the supertype member; the runtime target may be another implementation, so treat them as possible callers. Constructors and static members never dispatch and return only their direct callers. `super.member()` calls are stored with edge metadata `receiver: "super"` and are listed only as direct callers of the base member. Other member calls record `receiverType`, the indexed class or interface of the receiver's static type; a dispatch row is kept only when that type is one of the member's ancestors, so a sibling subclass that merely inherits the base member is not reported. Union, intersection and external receiver types stay unrecorded and remain possible callers. Calls to the same member on one line share an edge: it keeps `receiverType` only if every call had the same type and `receiver: "super"` only if every call was a super call. Stored edges keep their target: the call still targets the supertype member, and `trace_dependencies` does not add dispatch hops.

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

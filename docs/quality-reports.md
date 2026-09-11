# Code quality candidates

Reindex with alpha.12 or newer (parser revision 5) before querying these reports.
Old generations lack body fingerprints. Inspect `codebase_status`, generation,
pending changes, incomplete coverage and each report's unresolved-reference count.
No result is proof of absence. Results are repository-scoped SQL queries, with
limit 1–100 (default 20), offset pagination and the existing statement timeout.

`find_dead_code_candidates` reports named, non-exported implemented functions in
non-generated indexed files with no recorded non-containment incoming edge from
another symbol. Self-recursion does not suppress a candidate. Methods and anonymous
callbacks are excluded. Unreachable mutually recursive groups are not detected.
Check exports, external consumers, framework entry points, callbacks, dynamic
registration, tests and excluded sources before proposing removal.

`find_duplicate_code` groups exact function-body text, normalizing line endings
only. Comments, other whitespace, names inside bodies and literals matter. Names
and signatures outside the body do not. Default `minBodyLength` is 80 characters
(MCP accepts 20–100000). Each row identifies a member, hash, group size and source
location. Members of a group can span pages; keep the generation fixed while
paging. This is not semantic clone detection. Compare parameters, captures, side
effects, business contracts and both relationship directions before extracting
a shared helper. Neither report edits code.

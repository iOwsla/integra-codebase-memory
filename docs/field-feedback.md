# Field feedback follow-up

This backlog records reported behaviors without private source, repository paths or
raw field measurements. Reports identify candidate causes; those causes need a
minimal local regression before implementation claims.

| Finding | Current action |
| --- | --- |
| F-01 Cross-program consumers missing | Reproduce independent tsconfig programs, workspace aliases, exports and references; report structural coverage separately from file coverage. Open. |
| F-02 Literal dynamic import destructuring | Add a resolution fixture before choosing edge semantics or confidence. Open. |
| F-03 Old generation looks complete | Alpha.17 adds known-stale response flags and served generation tests. Watcher detection gaps remain possible. |
| F-04 Full reanalysis and BUSY as ERROR | Alpha.17 separates contention and backs off retries. Bounded semantic incremental analysis remains open. |
| F-05 Opaque trace nodes | Plan compact node identity/location metadata; traversal continuation needs a generation-aware contract. Open. |
| F-06 Duplicate report matches one body twice | Reproduce multiple declarations sharing one source body; canonicalize before group counts, preserving distinct same-line functions. Open. |
| F-07 Prisma/schema coverage | Design a schema plugin and link resolved client usages to models/fields; text-only coverage is not semantic coverage. Open. |
| F-08 JSX/shorthand references | Add fixtures for JSX elements, callbacks and shorthand properties before changing dead-code candidates. Open. |
| F-09 Trigram noise | Evaluate explicit exact/min-score search controls. Open. |
| F-10 Verbose symbols/outlines | Plan compact response projections and top-level outline controls with stable pagination. Open. |

## Prisma scope to design

Model, field, enum and named relation declarations need source locations, coverage
diagnostics and multi-file schema identity. Relations should distinguish relation
fields from stored foreign-key scalar fields, and preserve referential actions and
mapping names where parsed reliably. Client usage analysis must resolve the actual
generated client/schema and model delegate before linking a query or field access;
matching a common property name alone is insufficient.

Trace model-to-model relations and model-to-code consumers separately. Generated
types, aliases, injected clients, extensions, raw SQL and dynamic model/field names
need explicit unresolved evidence. Do not present text matches as confirmed Prisma
relations. Prisma support is not implemented in alpha.17.

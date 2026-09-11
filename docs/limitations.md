# Current limitations / release blockers

This is a runnable development foundation, not yet a production-certified v0.1.0 release.

- Source changes conservatively re-analyze all selected project sources. This preserves dependent relationship correctness; precise reverse-dependency invalidation and persistent TypeScript program reuse remain future optimization work.
- Queries load a consistent project snapshot into memory. Bounded output is enforced, but storage-level query pagination/FTS and large-repository memory budgets are not yet implemented. Exact/prefix/trigram and literal lexical search currently run in process.
- No standard-library or external npm declaration allowlist is enabled. External calls, dynamic calls, unresolved aliases and unsupported workspace resolution are recorded, not invented. Monorepos work with in-scope tsconfig paths; package-manager symlink-only resolution needs dedicated work.
- Multiple nearest `tsconfig.json`/`jsconfig.json` files and in-scope extends are supported. Full TypeScript solution-builder project references, arbitrary config filenames, conditional workspace exports and decorators need additional permanent fixtures before claiming exhaustive support.
- Parser regressions cover basic constructs, aliases, overloads, nested arrows, inheritance, cycles, optional calls, destructuring, TSX and JS. Accessor/anonymous identity collisions, complex inferred receivers and every construct listed in the original specification have not all been exhaustively validated.
- Parser diagnostics are persisted with index runs and make query results incomplete. Fatal plugin failures roll back the whole project, retaining the last completed graph; per-file retry/recovery is not yet implemented.
- Memory supports create/search/archive/supersede and local scopes; advanced type/tag/scope filters, durable symbol rename history and configurable scoring remain incomplete.
- Config is validated when a process starts. Restart sessions after editing `.codememory/config.json`; state files are deliberately not watched.
- Doctor checks runtime, connection, migrations/extensions, config, Git and scoped counts. Rich stale-job diagnosis/repair and stage-by-stage durable job progress remain incomplete.
- No optional embeddings, framework extraction, remote server, automatic memory inference, global memory access or global daemon. These are intentionally outside v0.1's core scope.
- CI is configured; a hosted CI run and cross-platform watcher validation must pass before tagging a release. Local tests are not a claim of hosted CI success.

Next milestone: close parser identity/project-resolution gaps with fixtures, then implement scoped SQL query paging and measure larger real repositories before release.

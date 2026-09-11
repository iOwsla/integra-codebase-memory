# Current limitations / release blockers

This is a runnable development foundation, not yet a production-certified v0.1.0 release.

- Source changes conservatively re-analyze all selected project sources. This preserves dependent relationship correctness; precise reverse-dependency invalidation and persistent TypeScript program reuse remain future optimization work.
- Queries load a consistent project snapshot into memory. Bounded output is enforced, but storage-level query pagination/FTS and large-repository memory budgets are not yet implemented. Exact/prefix/trigram and literal lexical search currently run in process.
- No standard-library or external npm declaration allowlist is enabled. External/dynamic targets remain unresolved. Declared package.json workspaces and in-scope TypeScript project references are supported; pnpm YAML-only workspaces, runtime package layouts and uncaptured package-based config extends need later adapters.
- Phase 3's static construct matrix is complete; see `parser.md` for tests and limits. One deterministic compiler config is selected per source. Anonymous/block-local identity may change when positions move; runtime dispatch and computed CommonJS exports are not inferred.
- Parser diagnostics are persisted with index runs and make query results incomplete. Fatal plugin failures roll back the whole project, retaining the last completed graph; per-file retry/recovery is not yet implemented.
- Memory supports create/search/archive/supersede and local scopes; advanced type/tag/scope filters, durable symbol rename history and configurable scoring remain incomplete.
- Config is validated when a process starts. Restart sessions after editing `.codememory/config.json`; state files are deliberately not watched.
- Doctor checks runtime, connection, migrations/extensions, config, Git and scoped counts. Rich stale-job diagnosis/repair and stage-by-stage durable job progress remain incomplete.
- No optional embeddings, framework extraction, remote server, automatic memory inference, global memory access or global daemon. These are intentionally outside v0.1's core scope.
- CI is configured; a hosted CI run and cross-platform watcher validation must pass before tagging a release. Local tests are not a claim of hosted CI success.

Next milestone: phase 5 scoped SQL query paging, followed by phase 6 memory filters and larger real-repository measurements before release.

# Current limitations / release blockers

This is a runnable development foundation, not yet a production-certified v0.1.0 release.

- Source changes conservatively re-analyze all selected project sources. This preserves dependent relationship correctness; precise reverse-dependency invalidation and persistent TypeScript program reuse remain future optimization work.
- Index queries use scoped SQL pagination and bounded graph reads. Broad/short lexical queries and high offsets can still cost database work; five-second SQL timeouts apply. Pagination across separate requests must restart if indexVersion changes. See search.md. Index reconciliation still loads a full scoped snapshot.
- No standard-library or external npm declaration allowlist is enabled. External/dynamic targets remain unresolved. Declared package.json workspaces and in-scope TypeScript project references are supported; pnpm YAML-only workspaces, runtime package layouts and uncaptured package-based config extends need later adapters.
- Phase 3's static construct matrix is complete; see `parser.md` for tests and limits. One deterministic compiler config is selected per source. Anonymous/block-local identity may change when positions move; runtime dispatch and computed CommonJS exports are not inferred.
- Parser diagnostics are persisted with index runs and make query results incomplete. Fatal plugin failures roll back the whole project, retaining the last completed graph; per-file retry/recovery is not yet implemented.
- Memory supports SQL-paged type/tag/scope filters and local scope lifecycle. Scope filters are exact, not inherited/recursive. Durable symbol rename history and configurable scoring remain future extensions; ordering is newest-first. Legacy path spellings are preserved; see memory.md.
- Config is validated when a process starts. Restart sessions after editing `.codememory/config.json`; state files are deliberately not watched.
- Doctor checks runtime, connection, migrations/extensions, config, Git and scoped counts. Rich stale-job diagnosis/repair and stage-by-stage durable job progress remain incomplete.
- No optional embeddings, framework extraction, remote server, automatic memory inference, global memory access or global daemon. These are intentionally outside v0.1's core scope.
- Hosted Linux CI and prerelease publication passed for alpha.2. Local macOS and hosted Linux coverage does not establish behavior on every OS or large production repository; these remain hardening gates.

Next milestone: phase 9 hardening and broader real-repository acceptance, followed by the stable-release documentation gate.

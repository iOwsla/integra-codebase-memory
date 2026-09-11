# Current limitations / release blockers

This is a runnable development foundation, not yet a production-certified v0.1.0 release.

- Source changes conservatively re-analyze all selected project sources. This preserves dependent relationship correctness; precise reverse-dependency invalidation and persistent TypeScript program reuse remain future optimization work.
- Index queries use scoped SQL pagination and bounded graph reads. Broad/short lexical queries and high offsets can still cost database work; five-second SQL timeouts apply. Pagination across separate requests must restart if indexVersion changes. See search.md. Index reconciliation reads a scoped file manifest and still hashes selected source files.
- No standard-library or external npm declaration allowlist is enabled. External/dynamic targets remain unresolved. Declared package.json workspaces and in-scope TypeScript project references are supported; pnpm YAML-only workspaces, runtime package layouts and uncaptured package-based config extends need later adapters.
- Phase 3's static construct matrix is complete; see `parser.md` for tests and limits. One deterministic compiler config is selected per source. Anonymous/block-local identity may change when positions move; runtime dispatch and computed CommonJS exports are not inferred.
- Parser diagnostics and recoverable source read failures make query results incomplete. Failed source files retry on the next index; fatal parser/config/discovery failures retain the prior graph. See hardening.md.
- Memory supports SQL-paged type/tag/scope filters and local scope lifecycle. Scope filters are exact, not inherited/recursive. Durable symbol rename history and configurable scoring remain future extensions; ordering is newest-first. Legacy path spellings are preserved; see memory.md.
- Config is validated when a process starts. Restart sessions after editing `.codememory/config.json`; state files are deliberately not watched.
- Doctor exposes latest-attempt stages, interrupted lock owners and bounded file errors. Recovery is an explicit index retry; progress is operational metadata separate from graph publication, not a full job history.
- No optional embeddings, framework extraction, remote server, automatic memory inference, global memory access or global daemon. These are intentionally outside v0.1's core scope.
- Supported verification scope is local macOS arm64 and hosted Linux. Windows, sustained production load and total peak memory across parser workers remain unverified. Real-repository samples are not production performance guarantees.

Next milestone: phase 9 hardening and broader real-repository acceptance, followed by the stable-release documentation gate.

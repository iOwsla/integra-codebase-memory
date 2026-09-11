# Project isolation

The amendment in `specifications/project-isolation.md` overrides the original product specification.

## Authority

`codememory mcp --project <absolute-path> --auto-index --watch` creates one immutable `ProjectContext`: random session ID, SHA-256 canonical-root scope ID, real root, validated effective config and parser/schema compatibility version. The index's numeric generation is persisted separately and returned as `indexVersion`.

Missing or relative MCP roots fail with `PROJECT_ROOT_REQUIRED` before database access or scanning. No cwd fallback, recent-project selection, registered-project iteration, home-directory discovery or parent Git-root expansion exists. Normal project MCP tools cannot list other projects. Source checkout roots, not remotes or shared Git metadata, determine identity.

## Boundaries

Scanner pruning, watcher pruning and file context containment exclude nested `.git` directories/files, submodules, default build directories, secrets and `.codememory`. The scanner honors inherited `.gitignore` rules and explicit include/exclude config. Watchers may monitor harmless in-scope non-source files so config and directory changes can trigger reconciliation, but never descend into ignored trees. All source symlinks are excluded, including internal symlinks.

The parser reads only the scanned in-memory source/config map. Standard compiler libraries and npm metadata outside the selected root are not currently allowlisted. Dependencies outside the selected scope stay unresolved. Package-manager symlink workspaces require in-scope tsconfig paths until dedicated resolution support lands.

Containment uses `path.relative`, canonical roots and realpath validation rather than string prefixes. This is application-level isolation, **not an OS sandbox**. Concurrent hostile filesystem replacement and same-user access to the shared PostgreSQL database are outside this guarantee.

## Lifecycle and consistency

One watcher belongs to one process. Changes are debounced; one index job runs at a time, and pending events are coalesced. A PostgreSQL session advisory lock also serializes separate processes on the same project. A busy session retries locally. Shutdown stops new jobs, closes its watcher, drops pending events, waits for a running index to commit/rollback, and closes its own database pool. Other sessions remain active. Reconciliation is confined to the selected root every 30 seconds by default.

The MCP transport is installed before auto-index work. Parsing runs in a subprocess so initialization/status requests can proceed. An unready graph raises `INDEX_NOT_READY`. Existing graphs are read as completed snapshots under REPEATABLE READ while a replacement is built. Parser diagnostics and skipped files mark query responses `incomplete`.

Unchanged source/config/parser fingerprints skip parsing and graph writes. Semantic changes currently use a conservative whole-selected-project re-analysis and report the reason. Deletions remove symbols and rebuild dependent edges; composite foreign keys reject dangling/cross-project edges. Code cleanup preserves memory.

## Acceptance evidence

- A–D: `tests/integration/isolation.test.ts` instruments scanner, hasher, parser and watcher entry points. B is registered before opening A; B modifications produce no work.
- E–G: simultaneous A/B sessions, foreign symbol/file/memory probes, and A shutdown while B remains active are covered in that suite.
- H: symlinks and traversal in `scope.test.ts`; actual Git worktrees, nested watcher pruning and multiple tsconfigs in `advanced.test.ts`.
- I: PostgreSQL `xmin` values prove unchanged symbol and edge rows are not rewritten.
- J: export removal repairs unchanged callers and clears target edges; config/parser fingerprints and broken-source diagnostics are tested in `changes.test.ts`.
- Lifecycle: real Bun subprocesses test EOF, SIGINT, SIGTERM, and SDK client transport close in `tests/e2e/mcp.test.ts`.

See the implementation tracker for remaining gaps; test instrumentation proves application activity boundaries, not kernel-level filesystem isolation.

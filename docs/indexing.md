# Indexing

Discovery prunes excluded trees before reading. Source files are bounded to 2 MiB by default, checked for NUL bytes, hashed with SHA-256 and tagged for generated code. The TypeScript plugin analyzes accepted files using a bounded compiler input map, configured workspace mounts and in-scope reference redirects. See parser.md for configuration ownership and declaration-output mapping. Unresolved references are persisted separately.

The index fingerprint combines parser version, schema compatibility, effective config and in-scope tsconfig/package/gitignore text. Reconciliation first reads a compact file hash/status manifest, without loading the graph. A no-op reopen skips all parser and graph writes; operational progress metadata is updated. Otherwise the selected project is conservatively re-analyzed for dependency correctness. File changes and deletion cleanup publish atomically with graph data and an index-run record. Parser diagnostics are returned as incomplete coverage; fatal failures retain the previous graph.

Configuration lives in `.codememory/config.json`. `init` writes documented defaults without replacing an existing config. Supported keys: `maxFileSizeBytes`, `parserTimeoutMs`, `include`, `exclude`, `excludeGenerated`, `debounceMs`, `reconcileMs`. Unknown keys fail validation. Restart the process after config changes.

Recoverable source read failures are recorded per file and retried on the next index. Durable stage/owner records expose abandoned attempts without deleting the last completed graph. See [hardening](hardening.md).

`parserTimeoutMs` defaults to 120000 and accepts integer milliseconds from 1000 to 600000. This bounds the isolated parser subprocess; it does not change the 256 MiB output cap or SQL query limits. Increase it only when a larger selected project requires a longer analysis window.

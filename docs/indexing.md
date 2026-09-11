# Indexing

Discovery prunes excluded trees before reading. Source files are bounded to 2 MiB by default, checked for NUL bytes, hashed with SHA-256 and tagged for generated code. The TypeScript plugin analyzes accepted files using a bounded compiler input map, configured workspace mounts and in-scope reference redirects. See parser.md for configuration ownership and declaration-output mapping. Unresolved references are persisted separately.

The index fingerprint combines parser version, schema compatibility, effective config and in-scope tsconfig/package/gitignore text. Reconciliation first reads a compact file hash/status manifest, without loading the graph. A no-op reopen skips all parser and graph writes; operational progress metadata is updated. Otherwise the selected project is conservatively re-analyzed for dependency correctness. File changes and deletion cleanup publish atomically with graph data and an index-run record. Parser diagnostics are returned as incomplete coverage; fatal failures retain the previous graph.

Configuration lives in `.codememory/config.json`. `init` writes documented defaults without replacing an existing config. Supported keys: `maxFileSizeBytes`, `parserTimeoutMs`, `parserOutputLimitMiB`, `include`, `exclude`, `excludeGenerated`, `debounceMs`, `reconcileMs`. Unknown keys fail validation. Restart the process after config changes.

Recoverable source read failures are recorded per file and retried on the next index. Durable stage/owner records expose abandoned attempts without deleting the last completed graph. See [hardening](hardening.md).

`parserTimeoutMs` defaults to 120000 and accepts integer milliseconds from 1000 to 600000. This bounds the isolated parser subprocess; it does not change the output cap or SQL query limits. Increase it only when a larger selected project requires a longer analysis window.

The isolated parser transfers newline-delimited records instead of buffering one giant JSON document. `parserOutputLimitMiB` defaults to 1024 and accepts integers from 1 to 8192. It bounds total transferred bytes, not process RAM: the compiler and resulting graph still require memory proportional to the project. Individual incomplete records are bounded to 64 MiB. A truncated stream is never published as a completed index.

For larger projects, merge these settings into `.codememory/config.json`, then restart the MCP session:

```json
{
  "parserTimeoutMs": 600000,
  "parserOutputLimitMiB": 2048
}
```

`codebase_status.error` retains the stable error code. `errorMessage` includes the isolated parser's safe diagnostic (output limit, deadline, failed exit or malformed stream) without echoing worker stderr or source content. It clears after a successful retry. These settings require a release containing the streaming parser; alpha.13/alpha.14 reject the new configuration key.

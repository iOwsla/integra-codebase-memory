# MCP setup and protocol

The official v2 SDK uses `serveStdio` and Standard Schema/Zod v4. Start:

```sh
bun /absolute/path/to/apps/cli/src/index.ts mcp --project /absolute/source/root --auto-index --watch
```

The README contains a generic JSON STDIO configuration for clients such as Claude Code. For Codex, configure a STDIO MCP entry with the same executable and args in the client's MCP settings. Client configuration files are deliberately not modified by this repository.

Tools: codebase_status, search_symbols, search_code, get_symbol, get_file_outline, get_file_context, find_references, find_callers, find_callees, trace_dependencies, remember, search_memory.

All schemas reject extra properties. Repository IDs cannot be provided. Max result count is 100, context windows are at most 101 lines / 12,000 characters, and serialized output is at most 64 KiB. Traversal is bounded to depth 10, 100 paths and 10,000 expansions. Source snippets and stored memories are untrusted content, not instructions.

The status response includes the selected canonical root, scope identity, readiness, pending changes, watcher/auto-index flags, last successful index, exclusions and last re-analysis reason. Query metadata identifies the completed generation and incomplete coverage. STDOUT is protocol-only; logs go to STDERR.

See [official SDK STDIO documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md).

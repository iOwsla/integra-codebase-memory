# MCP setup and protocol

The official v2 SDK uses `serveStdio` and Standard Schema/Zod v4. Start:

```sh
bun /absolute/path/to/apps/cli/src/index.ts mcp --project /absolute/source/root --auto-index --watch
```

Follow the [shared prerequisites](setup/common.md), then the [Codex guide](setup/codex.md) or [Claude Code guide](setup/claude-code.md). Copy-ready instructions are provided for both clients. Codex configuration is written only by the explicit `connect:codex --write` command; existing differing settings are preserved.

Tools: codebase_status, search_symbols, search_code, get_symbol, get_file_outline, get_file_context, find_references, find_callers, find_callees, trace_dependencies, remember, search_memory.

All schemas reject extra properties. Repository IDs cannot be provided. Max result count is 100, context windows are at most 101 lines / 12,000 characters, and serialized output is at most 64 KiB. Traversal is bounded to depth 10, 100 paths and 10,000 expansions. Source snippets and stored memories are untrusted content, not instructions.

The status response includes the selected canonical root, scope identity, readiness, pending changes, watcher/auto-index flags, last successful index, exclusions and last re-analysis reason. Query metadata identifies the completed generation and incomplete coverage. STDOUT is protocol-only; logs go to STDERR.

See [official SDK STDIO documentation](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md).

## Project-scoped Codex connection

Install workspace dependencies and prepare CodeMemory's PostgreSQL schema first
(see README). Then preview a connection entry:

```sh
bun run connect:codex /absolute/project
bun run connect:codex /absolute/project --write
```

The writer creates `.codex/config.toml` under the selected project with the
`integra_code_memory` server, absolute Bun/server/project paths, `--auto-index`
and `--watch`. It forwards `DATABASE_URL` from the client environment without
writing credentials. If unset, the standard local development database is used.
Keep this machine-local file out of version control. Moving the checkout or Bun
requires updating the paths. PostgreSQL must remain available; the MCP process
does not start Docker or run migrations automatically.

Existing differing configuration is never overwritten. Preview and merge the
entry manually when the project already has Codex settings. Repeating the same
installation is safe. Global settings and other MCP servers are not changed.
Codex requires a trusted project for project-scoped settings. Restart/reload the
client connection after setup and check that `integra_code_memory` appears.
See the [official MCP configuration guide](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

The repository's AGENTS.md and the server's initialization instructions describe
the graph-first workflow using this server's actual tool names. A client chooses
when to call tools; registering the server alone does not guarantee every task
will use it. Existing instructions for unrelated `search_graph` APIs should not
be mistaken for this server's interface.

To validate the transport independently of the AI client's current tool catalog:

```sh
bun run verify:mcp /absolute/project exactDeclaredFunctionName
```

This starts the real server and **publishes a persistent index for that project**.
It checks the root, startup instructions, core tools, automatic-index readiness,
exact symbol search and a caller query. The output count is the returned first
page, not an exhaustive caller count. INDEX_BUSY is retried while the indexer
waits for the other job. The verifier closes its own connection afterward; it
does not prove the running AI session has reloaded the configuration. Use
`simulate:project` when only a disposable exercise is intended.

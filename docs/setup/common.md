# Shared setup: the CodeMemory server

For automatic project-only integration, use the [installer](installer.md).

The CodeMemory repository contains the server installation; the target project
is the repository you want to index. These can be different directories. Replace
`/absolute/...` placeholders with your actual absolute paths. CodeMemory uses
local Bun and PostgreSQL; it does not require an API key. This package runs from
its source checkout and is not a standalone binary.

## Prerequisites and initial setup

For the managed bootstrap, install Bun 1.3.3+ and Git first; the bootstrap prepares
Docker and its dedicated PostgreSQL database. See [managed setup](installer.md#managed-docker-and-postgresql).
Windows PowerShell installation is tested; native Windows database/runtime
acceptance remains separate.

For manual development setup below, you need Docker Compose (or PostgreSQL with
`vector` and `pg_trgm`). This uses port 55432 and is independent of managed setup
on port 55433.

```sh
git clone https://github.com/iOwsla/integra-codebase-memory.git
cd integra-codebase-memory
bun install --frozen-lockfile
docker compose up -d --wait
bun run db:migrate
```

Find the absolute paths to Bun and the installation directory:

```sh
command -v bun
pwd
```

Run migrations only against CodeMemory's index database. Do not set `DATABASE_URL`
to your target application's database. The default development database listens
on `127.0.0.1:55432`; its credentials are defined in the Compose file. For a custom
index database, provide `DATABASE_URL` in the client's environment. Do not write
secrets into shared MCP settings or instruction files.

Starting MCP does not run migrations, start Docker or install dependencies.
After restarting your machine, verify that PostgreSQL is running. Keep the source
checkout and its `node_modules` directory available. The server entry point is:
`/absolute/integra-codebase-memory/apps/cli/src/index.ts`.

## Choose your client

- [Codex setup](codex.md)
- [Claude Code setup](claude-code.md)

Create a separate connection for each target project. A global connection with a
single fixed project path can query the wrong index when you work in another
repository. Two clients connected to the same target may run separate watchers;
index writes are serialized with a lock. This is not a shared daemon.

## Install the instructions

The [AGENTS.md template](../instructions/AGENTS.md) and
[CLAUDE.md template](../instructions/CLAUDE.md) contain the same self-contained
instruction block. If the target file does not exist, save the appropriate
template under that name at the project root. If it already exists, merge the
`integra-code-memory:start/end` block without overwriting project rules. When
updating, replace only the matching marked block rather than adding another copy.

Older `codebase-memory-mcp` instructions belong to a different server. If you use
both servers, distinguish their rules by server name. Do not require calls to
`search_graph` or `check_index_coverage`, which our server does not expose.
These templates guide AI behavior; they are not an access-control mechanism or
a guarantee of exhaustive analysis or compliance on every call.

## Verification and troubleshooting

Send this prompt to your client:

> Call codebase_status through integra_code_memory. Report the project root,
> index version, pending changes and any incompleteness. Then find an existing
> project function with search_symbols and query find_callers using its ID.

Expect the correct root, READY, autoIndex=true and watcher=true; pending changes
should eventually reach zero. Review file errors and incomplete status separately.
An empty caller list alone is neither a connection failure nor proof of dead code.

For a protocol check independent of the client, run from the CodeMemory installation:

```sh
bun run verify:mcp /absolute/target-project exactDeclaredFunctionName
```

This creates or updates the target's persistent index. It does not independently
prove that your AI client has loaded its tool catalog. Use `simulate:project` for
a disposable exercise. If the connection selects the wrong root, stop querying
and correct the configured `--project` path. Wait for transient INDEX_BUSY states;
do not treat INDEX_NOT_READY as an empty result. For connection failures, check
PostgreSQL, dependencies and absolute paths. Restart the client connection after
configuration changes.

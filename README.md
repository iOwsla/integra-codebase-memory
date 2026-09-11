# CodeMemory

Local code intelligence and explicit project memory for MCP coding agents. Bun + TypeScript Compiler API + PostgreSQL. No telemetry, LLM inference, embeddings or external code uploads.

**Development foundation (`0.1.0-alpha.7`)**. It indexes JS/JSX/TS/TSX/MJS/CJS/MTS/CTS declarations, imports, static calls, references and inheritance. It provides 12 bounded MCP tools, a CLI, project memory and process-owned watchers. Read [implementation status](docs/implementation-status.md) and [limitations](docs/limitations.md) before using it as an exhaustive source of truth. This is an alpha prerelease; production release gates remain open.

## Install and run

Requirements: Bun 1.3.3+, Git, Docker with Compose (or PostgreSQL with `vector` and `pg_trgm`).

```sh
bun install --frozen-lockfile
docker compose up -d --wait
bun run db:migrate
bun run build
bun run dev --help
```

The Compose database listens only on `127.0.0.1:55432`. Its development credentials are defined in `docker-compose.yml`. Override `DATABASE_URL` for your own database. Migrations are explicit and forward-only; starting MCP does not migrate schemas.

```sh
bun run dev init --project /absolute/path/to/repository
bun run dev index --project /absolute/path/to/repository
bun run dev symbol completeOrder --project /absolute/path/to/repository
bun run dev callers completeOrder --project /absolute/path/to/repository
bun run dev doctor --project /absolute/path/to/repository
bun run dev remember --project /absolute/path/to/repository \
  --type DECISION --title 'Business day' --content 'The business day starts at 04:00.'
bun run dev memories --project /absolute/path/to/repository
bun run dev mcp --project /absolute/path/to/repository --auto-index --watch
```

For a `codememory` executable, run `bun link` inside `apps/cli`, or invoke the absolute `apps/cli/src/index.ts` path with Bun. Keep the workspace and dependencies installed; the build is a Bun entry point, not a standalone binary.

Only MCP requires an explicit absolute `--project`. CLI indexing accepts a positional path; commands without a path use the current directory and never climb to a Git root. No command automatically scans other registered projects.

## MCP client configuration

Use your client's STDIO configuration, with absolute paths:

```json
{
  "mcpServers": {
    "codememory": {
      "command": "/absolute/path/to/bun",
      "args": [
        "/absolute/path/to/integra-codebase-memory/apps/cli/src/index.ts",
        "mcp", "--project", "/absolute/path/to/your/project",
        "--auto-index", "--watch"
      ]
    }
  }
}
```

Create a separate configuration for each selected project. The MCP process cannot switch projects or accept a repository ID from a tool call. Its first index runs asynchronously. Query `codebase_status` until ready; `INDEX_NOT_READY` is an error, not an empty search result.

## How indexing works

The scanner respects `.gitignore`, config exclusions, source size limits, secret exclusions, and nested repository boundaries. All symlinks are excluded. Compiler reads use the scanner's in-memory allowlist. Unresolved and external calls remain explicit. Declared workspaces, conditional exports and in-scope project references are supported without builds; see [parser coverage](docs/parser.md).

Hashes and parser/config/schema fingerprints prevent parsing or graph writes on an unchanged reopen. Source changes currently trigger conservative semantic re-analysis of the **selected project** to repair dependent callers. Reconciliation uses a compact file manifest. Only changed file content is persisted; complete graph publication is one PostgreSQL transaction. Index queries use scoped SQL pages and bounded graph traversal within one completed generation; see [search and upgrade notes](docs/search.md). Existing databases require `bun run db:migrate` for migrations 2–4. Memory filters and CLI examples are documented in [project memory](docs/memory.md).

A session watcher reconciles events and periodically scans its own project to recover missed events. It stops on STDIN EOF, transport close, SIGINT or SIGTERM. There is no global daemon.

## Development

```sh
bun run lint
bun run typecheck
bun run test           # unit + isolated PostgreSQL integration + real MCP/CLI E2E
bun run build
bun run benchmark 1000
```

Tests create and remove uniquely named databases. `TEST_DATABASE_URL` selects the administrative connection used to create those test databases; it must have `CREATEDB`. Tests never migrate that database directly.

[Architecture](docs/architecture.md) · [Project isolation](docs/project-isolation.md) · [MCP](docs/mcp.md) · [Regression policy](docs/regression-policy.md) · [Development tracker](docs/implementation-status.md)

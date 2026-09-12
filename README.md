# CodeMemory

Local code intelligence and explicit project memory for MCP coding agents. Bun + TypeScript Compiler API + PostgreSQL. No telemetry, LLM inference, embeddings or external code uploads.

**Development foundation (`0.1.0-alpha.21`)**. It indexes JS/JSX/TS/TSX/MJS/CJS/MTS/CTS declarations, imports, static calls, references and inheritance, plus Prisma schema relations and statically resolved model usages. It provides 14 bounded MCP tools, a CLI, project memory and process-owned watchers. Read [implementation status](docs/implementation-status.md) and [limitations](docs/limitations.md) before using it as an exhaustive source of truth. This is an alpha prerelease; production release gates remain open.

Management commands and reboot recovery: [CLI guide](docs/installation.md). Large project parser settings: [indexing guide](docs/indexing.md).

## Install into the current project

Open a terminal **inside the project you want to index**. Install Bun 1.3.3+ and Git first. The bootstrap installs the management CLI before preparing Docker and dedicated PostgreSQL. Docker permissions/first-run prompts and a Windows reboot may require interaction.

### macOS and Linux

```sh
curl -fsSL https://raw.githubusercontent.com/iOwsla/integra-codebase-memory/v0.1.0-alpha.21/bootstrap.sh | sh -s -- --project "$PWD" --client both --write
export PATH="${XDG_DATA_HOME:-$HOME/.local/share}/integra-code-memory/cli/bin:$PATH"
```

### Windows PowerShell 5.1 or 7

```powershell
$installer = (Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/iOwsla/integra-codebase-memory/v0.1.0-alpha.21/bootstrap.ps1').Content
& ([scriptblock]::Create($installer)) -Project (Get-Location).Path -Client both -Write
$env:Path = "$env:LOCALAPPDATA\integra-code-memory\cli\bin;$env:Path"
```

Choose `codex`, `claude` or `both`. Omit `--write` / `-Write` to preview. The PATH commands above affect the current terminal; add the printed CLI directory to your shell profile or Windows user PATH for future terminals. The installer also prints the full executable path.

The managed database listens on `127.0.0.1:55433`. For an already prepared external database, add `--skip-services` / `-SkipServices` and retain your `DATABASE_URL`. Do not use an application's production database as the index database.

After a requested Windows reboot, reopen a terminal and resume only the selected registered project:

```sh
codememory system status
codememory system setup --project /absolute/project
```

On Windows use `codememory system setup --project (Get-Location).Path` from the project directory. Open/reload the project's MCP connection in Codex or Claude Code; automatic indexing starts when that connection opens. [Detailed platform setup](docs/setup/installer.md).

## Update an existing installation

Starting with alpha.17, the CLI and registered projects use stable launchers in
the shared user installation. Update once from any directory:

```powershell
codememory.cmd update
```

Use `codememory update` on macOS/Linux. `codememory updates` only checks for a
release. `update` downloads a published release, validates it, preflights existing
enabled registered projects, backs up changed settings, stops verified CodeMemory MCP
processes for those projects, and switches the shared active runtime. It does not
index every project, delete databases, remove old release folders or install in
the background. Reconnect open Codex/Claude MCP connections afterward.

### One-time migration from alpha.16 or older

Run this once from **one registered project**, keeping that project's original
client and database mode. Other existing registered projects are migrated using
their own saved settings. Conflicting configurations stop the upgrade before
process termination; unrelated client settings are preserved.

Windows, for a managed Docker/PostgreSQL installation:

```powershell
$installer = (Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/iOwsla/integra-codebase-memory/v0.1.0-alpha.21/bootstrap.ps1').Content
& ([scriptblock]::Create($installer)) -Project (Get-Location).Path -Client both -Upgrade -Write
$env:Path = "$env:LOCALAPPDATA\integra-code-memory\cli\bin;$env:Path"
codememory.cmd --version
codememory.cmd system status
```

For an **external database / alpha.13 installation**, add `-SkipServices`.
The selected database mode cannot silently change during migration.

macOS/Linux, managed installation:

```sh
curl -fsSL https://raw.githubusercontent.com/iOwsla/integra-codebase-memory/v0.1.0-alpha.21/bootstrap.sh | sh -s -- --project "$PWD" --client both --upgrade --write
export PATH="${XDG_DATA_HOME:-$HOME/.local/share}/integra-code-memory/cli/bin:$PATH"
codememory --version
```

Add `--skip-services` for an external database. Omit the write flag to preview the
selected project's configuration. Activation performs a second preflight across
the registry. Missing project directories are skipped and reported, not recreated.

After success, reconnect open clients and verify `codebase_status.runtime.version`
is `0.1.0-alpha.21`. `system status.activeRuntime` shows the shared target. Project
roots and index data remain separate. Older unregistered project connections need
explicit registration; the updater never searches your home folder for projects.
See [update recovery and process boundaries](docs/installation.md#shared-runtime-updates)
for backups, interrupted updates, database migrations and process limitations.

## Everyday CLI commands

Run from the selected project's directory; adding or indexing it needs no path argument:

```sh
codememory projects add --client both
codememory index
codememory status
codememory status --watch
codememory projects list
codememory projects remove --yes
codememory updates
```

Use `projects add --no-index` while the database is not ready. Add `--external-db` to `projects add` when using an external index database. Paths remain optional for add/index/remove; a child directory stays the selected scope and never expands to a parent Git root. Listing projects does not scan or index them.

`projects remove --yes` disables future sessions and retains source, index and memory. Close existing sessions first. The older top-level `remove --yes` command purges database content and is a different operation.

`system start` prepares/starts managed services. `system restart --project /absolute/project` recreates the managed PostgreSQL container, retains its volume and indexes only that registered project. Existing MCP sessions may need reconnecting. See [CLI and recovery details](docs/installation.md).

`index` displays live scan/analysis/publication progress on stderr, including
sampled file names and elapsed time. Its final stdout result remains JSON.
Use `index --no-progress` to silence it. In another terminal, `status --watch`
follows durable job stages without starting indexing; add `--json` for JSON lines.
[Progress semantics and output controls](docs/installation.md#live-indexing-progress).

## Prisma models and usages

`.prisma` models, fields and relations are indexed alongside source code. Model usage follows client/delegate provenance, including `const user = database.user; user.findMany()`, imported aliases and transactions. Search a `MODEL`, then use `find_references` with its ID for files, call lines and operation names. See [Prisma coverage, examples and limitations](docs/prisma.md). Reindex the selected project after updating.

## Large project parser settings

The parser streams records instead of buffering one giant JSON output. Its default total output limit is 1024 MiB. If more is needed, merge these settings into `.codememory/config.json` and restart the MCP session:

```json
{
  "parserTimeoutMs": 600000,
  "parserOutputLimitMiB": 2048
}
```

These settings require alpha.15 or later. They do not eliminate compiler/graph memory requirements. Parser failure details appear in `codebase_status.errorMessage`; [coverage and limits](docs/indexing.md) remain explicit.

## Source checkout / development setup

```sh
bun install --frozen-lockfile
docker compose up -d --wait
bun run db:migrate
bun run build
bun run dev --help
```

The development Compose database uses `127.0.0.1:55432`, separate from managed installation port 55433. For project integration from this checkout, run `./install.sh --project /absolute/project --client both --write`; add `--with-services` for managed provisioning or `--upgrade` to retarget an existing compatible connection. Windows uses `./install.ps1 -Project C:\Projects\Example -Client both -Write`, with `-WithServices` / `-Upgrade` equivalents.

These are source releases requiring Bun and workspace dependencies, not standalone binaries. Starting MCP never installs software or migrates schemas. Update checks use the fixed public GitHub releases API when status is queried; they upload no project data and can be disabled with `CODEMEMORY_UPDATE_CHECK=0`. The AI is instructed to ask before updating. There is no background update installer.

## MCP client configuration

Start with the [shared setup guide](docs/setup/common.md), then follow
[Codex](docs/setup/codex.md) or [Claude Code](docs/setup/claude-code.md).
Ready-to-copy rules: [AGENTS.md](docs/instructions/AGENTS.md) and
[CLAUDE.md](docs/instructions/CLAUDE.md).


Use your client's STDIO configuration, with absolute paths:

```json
{
  "mcpServers": {
    "integra_code_memory": {
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

For automatic Codex startup, use `bun run connect:codex /absolute/project --write`.
See [MCP setup](docs/mcp.md) for prerequisites and verification, and
[stable release acceptance](docs/release-readiness.md) for remaining product gates.

## Code quality candidates

Use `find_dead_code_candidates` and `find_duplicate_code` through MCP, or run
`bun run dev dead-code --project /absolute/project` and
`bun run dev duplicates --project /absolute/project` after indexing. See
[report scope and limitations](docs/quality-reports.md).


### Understand incomplete results

`READY` means a published graph is available; it does not certify complete analysis.
`status` / `codebase_status` now expose `incompleteReasons`, `diagnosticSummary`,
`exclusions`, `analysisScope`, `runtime` and `lastIndexJob.owner`.
Parser errors include one-based line/column and TypeScript diagnostic codes in
`last_run.diagnostics`; `fileErrors` specifically describes file read failures.

```powershell
codememory.cmd status --diagnostic-limit 10 --diagnostic-offset 0
# Next page, using diagnosticSummary.nextOffset:
codememory.cmd status --diagnostic-limit 10 --diagnostic-offset 10
```

On macOS/Linux use `codememory`. MCP accepts the equivalent `diagnosticLimit`
and `diagnosticOffset` arguments. See [coverage and diagnostics](docs/installation.md#coverage-and-diagnostics)
for exclusions, preview continuation and process recovery. Alpha.16 uses parser
revision 6, so the next index rebuilds metadata even when source files are unchanged.

Legacy entry scripts inside the managed releases directory are redirected to the
shared dispatcher after their original contents are backed up. This prevents cached
old client commands from restarting an outdated engine. The remaining release
files are retained; a retired release checkout contains these intentional local
changes. Original entry scripts are in the first activation backup's
`rollback.json`. Source checkouts/custom locations outside managed releases are
not rewritten. Disabled registrations are skipped, not re-enabled by an update.

### Windows command discovery

Windows installation and updates automatically repair the current user's PATH,
placing the shared `cli\bin` launcher first in the user PATH. Repeated installs
remove duplicate entries, an incorrectly added `cli` directory, and old release
`bin` / `cli\bin` entries under the same installation root. Other entries and
the machine PATH are preserved. No administrator access is needed for this repair.

The PowerShell installer also refreshes its invoking session. After a CLI update,
close all existing Windows Terminal windows (or restart the IDE hosting your
terminal), then run `where.exe codememory.cmd` and `codememory.cmd --version`.
Already-running parent applications cannot receive a changed process environment
from the CLI child process. If an unrelated or machine-level installation shadows
the command, inspect `where.exe codememory.cmd`; it is not deleted automatically.

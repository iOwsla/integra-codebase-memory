# Project-only installer

Run the installer from an existing CodeMemory source checkout. Complete the
[shared prerequisites](common.md) first: Bun, installed server dependencies and a
prepared CodeMemory PostgreSQL database for connection-only mode. Add
`--with-services` (`-WithServices` in PowerShell) to install/start Docker, prepare
managed PostgreSQL and run migrations before writing the project connection.
Curl/PowerShell bootstraps select managed services by default.

```sh
# Preview the files that would change; no writes:
./install.sh --project /absolute/target-project --client both

# Apply the integration:
./install.sh --project /absolute/target-project --client both --write

# Install only one client instead:
./install.sh --project /absolute/target-project --client codex --write
./install.sh --project /absolute/target-project --client claude --write
```

Both `--project` and `--client` are required. Relative roots are rejected. The
installer never walks up to a Git root, searches for sibling projects, or adds a
global MCP entry. You may invoke `/absolute/CodeMemory/install.sh` from any working
directory. Quote paths containing spaces. Keep the server checkout and Bun at
the installed paths.

## Installed files

| Client | Files in the selected project |
| --- | --- |
| Codex | `.codex/config.toml`, the marked block in `AGENTS.md` |
| Claude Code | `.mcp.json`, the marked block in `CLAUDE.md` |
| Both | Both connection files, a shared block in `AGENTS.md`, and an import in `CLAUDE.md` |

If CLAUDE.md already imports AGENTS.md, its contents are preserved and the shared
block is maintained in AGENTS.md. Existing project instructions outside the
installer's markers are preserved. An existing standalone managed Claude block
can be changed to an AGENTS import when installing both clients.

The installer also maintains a marked `.gitignore` block for the two machine-local
connection files. Ignore rules do not untrack files already committed; inspect
those separately before publishing. Other configuration and instructions remain
available to the clients. No database credentials are written into new entries.
Other servers' existing settings are retained and are never printed in the
installer's output.

## When indexing starts

Open the configured target in Codex or Claude Code. The client launches its own
STDIO server process with a fixed `--project` root, `--auto-index` and `--watch`.
Only that selected root is reconciled; registered projects elsewhere are not
scanned. On unchanged reopen, hashing still runs but parsing/graph publication
are skipped. PostgreSQL must be running. Client trust or MCP approval may be
required; reload the connection and query `codebase_status` to verify the root.

An ancestor project's client configuration may apply in its subdirectories, so
always check the reported root when switching projects or worktrees. The installer
does not relocate a connection automatically. Install separately for a distinct
worktree/project root.

Existing global servers, including a separate `codebase-memory-mcp` installation,
are not disabled. They may continue their own work independently. Existing client
entries with the same server name can also affect which configuration is selected;
check the effective client entry and returned project root. Remove or
disable an unwanted legacy global connection through that client's settings;
this installer only controls this project's `integra_code_memory` entry.

## Preservation and retry behavior

All configuration and instruction conflicts are checked before applying edits.
Other Codex TOML tables are preserved as text; other Claude JSON entries are
preserved as data. An existing CodeMemory entry must match the generated root,
command and required settings; a conflicting entry is refused rather than silently
redirected. Malformed configuration, ambiguous markers, linked files and redirected
configuration directories are refused. An unchanged rerun reports no changed files.

Individual file replacements are atomic, but the whole installation is not one
filesystem transaction. An I/O failure or concurrent edit during application can
leave some files updated. Review the selected project's changes and rerun after
resolving the cause. Do not edit configuration concurrently with installation.

To remove the integration, remove only the `integra_code_memory` server entries,
the matching instruction/import blocks and the installer ignore block if no longer
needed. Preserve unrelated settings. This does not delete the persistent index
or stored project memory.

The previous `connect:codex` command remains available as a config-only preview/
writer. Use this installer when you also want instruction blocks and merging with
other server settings. See the [Codex](codex.md) and [Claude Code](claude-code.md)
guides for client verification and manual configuration alternatives.

## Curl bootstrap

Install Bun 1.3.3+ and Git first. The bootstrap downloads the pinned release and
runs `bun install --frozen-lockfile --ignore-scripts`, then prepares Docker and
managed PostgreSQL, applies migrations, and configures the selected client.
It does not index any repository; that starts when the client opens its connection.
Pass `--skip-services` to keep using an externally prepared index database.

```sh
curl -fsSL https://raw.githubusercontent.com/iOwsla/integra-codebase-memory/v0.1.0-alpha.25/bootstrap.sh | sh -s -- --project /absolute/target-project --client both --write
```

For inspection before execution, download with `curl -fLo bootstrap.sh` using the
same URL, review the file, then run `sh bootstrap.sh` with the same arguments.
Omit `--write` to preview without downloading or creating files.

Default runtime: `$XDG_DATA_HOME/integra-code-memory/releases/v0.1.0-alpha.25`,
or `$HOME/.local/share/integra-code-memory/releases/v0.1.0-alpha.25`. Override with
`--install-dir /absolute/runtime`. Keep the active runtime directory: the shared
launcher selects it through the private active-runtime pointer. Client settings
refer to the shared launcher. Repeating the command reuses a clean checkout with the expected origin and
tag; it refuses other existing directories and modified checkouts. Downloads use
a temporary directory, removed on failure. If project configuration conflicts,
the downloaded runtime remains available while project changes are rejected by
the project installer.

From alpha.17 onward, run `codememory update` (`codememory.cmd update` on Windows)
once to update the shared runtime. For the first migration from older releases,
install the next pinned release into its own directory and pass `--upgrade` /
`-Upgrade` together with the write flag. Existing enabled registered projects are
preflighted together and recognizable Bun MCP entries are retargeted after backups
are saved outside the repositories. Other servers and custom settings are preserved.
The shared update output includes `backupDirectory`. Database mode is retained: alpha.13 and external-database
installations need `--skip-services` / `-SkipServices`. Custom commands/arguments,
ambiguous TOML and different project roots are refused before project writes.
See [complete upgrade commands and rollback](../../README.md#update-an-existing-installation).
Native binary distribution and unattended automatic updating are not provided.

## Windows PowerShell

Use Windows PowerShell 5.1 or PowerShell 7 on Windows with Bun 1.3.3+ and Git
installed. Run this in PowerShell, replacing the project path:

```powershell
& ([scriptblock]::Create((Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/iOwsla/integra-codebase-memory/v0.1.0-alpha.25/bootstrap.ps1').Content)) -Project 'C:\Projects\My App' -Client both -Write
```

Choose `codex`, `claude` or `both`. Omit `-Write` for a no-write preview.
The runtime defaults to `%LOCALAPPDATA%\integra-code-memory\releases\v0.1.0-alpha.25`;
use `-InstallDir 'D:\Tools\CodeMemory'` to choose another location. Drive-relative
paths are rejected. Runtime junctions and symbolic links are rejected.
Bash is not required. Docker/WSL preparation may request administrator permission
and a restart. Docker first-run/license prompts remain visible. Use `-SkipServices`
for connection-only setup with your own prepared index database. The installer
never scans other projects or changes global client configuration.

For review before execution, download the script and run it in a child process:

```powershell
Invoke-WebRequest -UseBasicParsing 'https://raw.githubusercontent.com/iOwsla/integra-codebase-memory/v0.1.0-alpha.25/bootstrap.ps1' -OutFile bootstrap.ps1
Get-Content .\bootstrap.ps1
powershell.exe -NoProfile -ExecutionPolicy Bypass -File .\bootstrap.ps1 -Project 'C:\Projects\My App' -Client both -Write
```

The execution policy argument applies to that process, not a persistent registry
setting ([Microsoft documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.core/about/about_powershell_exe?view=powershell-5.1)).
Organizational Group Policy can still prevent execution. In PowerShell 5.1,
`curl` may be an alias; the examples use `Invoke-WebRequest -UseBasicParsing`
explicitly ([Microsoft documentation](https://learn.microsoft.com/en-us/powershell/module/microsoft.powershell.utility/invoke-webrequest?view=powershell-5.1)).

From an existing source checkout with dependencies installed:

```powershell
.\install.ps1 -Project 'C:\Projects\My App' -Client both -Write
```

Repeated installation, conflict preservation and explicit version upgrades follow
the same rules as the shell installer. Windows CI covers installation and
configuration; full native Windows database/indexer acceptance remains separate.

## Managed Docker and PostgreSQL

The bootstrap now prepares the database by default. From a source checkout:

```sh
./install.sh --project /absolute/project --client both --with-services --write
```

```powershell
.\install.ps1 -Project 'C:\Projects\My App' -Client both -WithServices -Write
```

- macOS (Intel/Apple silicon): reuse a working engine; otherwise download Docker's
  official DMG, run its installer with sudo, open Desktop and wait for its engine.
- Windows x64: reuse a working Linux engine; otherwise prepare current WSL without
  Ubuntu, request elevation when required, verify the downloaded Docker installer
  signature, and launch Desktop. A required restart stops setup with a clear
  message. Restart Windows and rerun the same command; no automatic reboot occurs.
- Ubuntu/Debian/Fedora: reuse Docker or install Engine and Compose from Docker's
  package repositories, then enable/start the systemd service. Conflicting
  packages are not removed. Other distributions require manual Engine/Compose
  installation before retrying. Existing rootless/local engines may be reused.

Bun and Git remain bootstrap prerequisites. Docker's supported OS/hardware rules
apply; enabling a Windows feature cannot repair unsupported hardware. Desktop
license/first-run prompts and OS elevation remain user interactions. No license
terms are silently accepted.

Service identity and credentials live outside release and target-project folders:
`$XDG_DATA_HOME/integra-code-memory/service` (fallback `$HOME/.local/share/...`) or
`%LOCALAPPDATA%\integra-code-memory\service`. This private directory contains
`service.json` and generated `compose.json`; keep both out of Git and back up the
credentials with the database. Unix files are created with mode 0600. On Windows
they inherit the user-profile ACL; do not relocate them into shared directories.

The managed database uses localhost port **55433**, a random password, PostgreSQL
17 with pgvector, Compose project `integra-code-memory`, and volume
`integra-code-memory-pg17`. Its restart policy is `unless-stopped`. Release folder
changes do not change the volume or password. An orphan volume, ownership mismatch,
remote Docker context or occupied port fails without deleting existing data.
Setup never runs `down --volumes`, prunes Docker, or migrates an application DB.
It ignores inherited `DATABASE_URL` in managed mode.

The project connection uses `scripts/managed-mcp.ts`, which reads local credentials
and passes them to the MCP process. Client entries explicitly carry the private
state directory path so GUI/terminal environment differences do not select a
different database. Secrets are not embedded in client config.
On Linux, provisioning may use sudo for Docker access; MCP itself only connects
to PostgreSQL and needs no Docker group membership.

Docker Desktop/Engine must still be running when MCP starts. Enable Desktop's
start-at-login setting if desired; container restart policy only takes effect
after the engine starts. MCP does not install software, elevate privileges or
run migrations during an AI session. To repair/start/migrate the managed service,
rerun the managed installer (or `bun scripts/setup/services.ts` from its runtime).
Never delete `service.json` to repair a failed install; restore a matching backup
if it is missing. An interrupted setup may leave `setup.lock`; remove only that
lock after confirming no setup process is running.

Switching an existing connection-only entry to managed mode is an explicit
connection change. Review/remove only its `integra_code_memory` server entry, then
rerun managed installation; conflicts are preserved rather than overwritten.
Existing development databases on port 55432 are neither adopted nor migrated.

Verification includes real managed PostgreSQL health/migrations/restart/launcher
tests on macOS and Linux, portable orchestration tests, and Windows PowerShell
installer tests. Clean Docker Desktop installation and WSL reboot flows still
require interactive machine acceptance; hosted Windows runners do not establish
that every laptop supports virtualization.

See [Management CLI and restart recovery](../installation.md) for service lifecycle, project registrations and update notifications.

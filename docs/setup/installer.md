# Project-only installer

Run the installer from an existing CodeMemory source checkout. Complete the
[shared prerequisites](common.md) first: Bun, installed server dependencies and a
prepared CodeMemory PostgreSQL database. The installer itself needs no database
connection and does not start the server, index sources, install dependencies or
run migrations.

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

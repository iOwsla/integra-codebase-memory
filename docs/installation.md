
## Management CLI and restart recovery

An applied installer installs a user-local `codememory` launcher **before** preparing Docker, WSL or PostgreSQL. Its absolute path is printed even when a reboot interrupts service setup. Add the printed `bin` directory to your user PATH once; alternatively invoke the full path (PowerShell: `& 'C:\path\to\codememory.cmd' system status`). The CLI still requires the installed Bun runtime. It never edits global MCP settings.

```sh
codememory system status
codememory projects list
codememory system setup --project /absolute/project
codememory system restart --project /absolute/project
codememory projects add /absolute/another-project --client both --no-index
codememory projects remove /absolute/another-project --yes
codememory updates
```

`system status` and `projects list` work before database installation. `system setup` resumes a pending managed registration, prepares services, reapplies its project configuration and indexes **only** the selected project. `system start` uses the same health-checked setup path. `system restart` recreates the owned PostgreSQL container while retaining its volume and credentials; other active MCP connections may need reconnecting. Omitting `--project` only manages services and does not index registered projects.

`projects add [path]` defaults to the current working directory when no path is supplied; it never expands to a parent Git root. For example, run `codememory projects add --client both` inside the project. `codememory index` and `projects remove --yes` also accept the current directory.

`projects add` installs the selected client's project configuration and indexes immediately. Use `--no-index` to defer indexing, or `--external-db` to use your own `DATABASE_URL`. A failed index leaves the registration available for retry. `projects remove --yes` disables future MCP sessions without deleting source files, client settings, database indexes or memories. Close existing sessions first; re-adding the project enables it. The older `remove --project ... --yes` command is a separate destructive database purge.

Registrations are local to the operating-system user and stored outside repositories. Reinstalling the CLI replaces its launcher; existing project connections retain their configured runtime until explicitly updated. The installer continues to reject conflicting existing MCP entries instead of overwriting them.

## Update notifications

`codememory updates` checks the fixed public GitHub releases endpoint. MCP `codebase_status` includes the same `updates` information, cached for 24 hours per server process. Alpha installations include alpha releases; stable installations stay on stable releases. Requests contain no project root, source, database URL or stored memory. Network failures report `unavailable` and do not block indexing. Set `CODEMEMORY_UPDATE_CHECK=0` in the MCP process environment to disable checks.

When a newer release is reported, the client instructions ask the AI to notify you and request your approval. This is an instruction to the assistant, not an enforced notification UI or a background scheduler: the client must call `codebase_status`. No files are downloaded or updates applied automatically. After approval, follow the release's installation instructions and review any existing project configuration conflicts before switching runtime paths.

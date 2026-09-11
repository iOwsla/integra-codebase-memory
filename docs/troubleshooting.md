# Troubleshooting

- PROJECT_ROOT_REQUIRED: provide an absolute `--project` for MCP. No scanning has started.
- Connection failure: start Docker/Compose or set DATABASE_URL; run db:migrate explicitly. Enable CODEMEMORY_DEBUG=1 locally for exception details, redacting credentials before sharing logs.
- INDEX_NOT_READY: run index or enable auto-index and query codebase_status.
- INDEX_BUSY: another process holds the selected project's advisory lock; automatic sessions retry. Locks are connection-owned and released when the connection closes.
- Empty/partial results: inspect incomplete, file skip statuses and `debug unresolved`; unresolved dependencies are not proof of absence.
- Unexpected aliases: use a symbol ID rather than an ambiguous name.
- Config changes: restart the session. Config files are strictly validated; state files do not trigger the watcher.
- Watcher problems: check ignore/exclude rules, symlinks and nested Git boundaries. A project-local periodic reconciliation recovers missed events.

Doctor is read-only. No automatic destructive repair exists.

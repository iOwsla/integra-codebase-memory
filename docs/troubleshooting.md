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

`doctor` and `status` expose `lastIndexJob`. If `interrupted` is true, rerun
`index --project /absolute/path`; the prior graph is retained until successful
publication. A live lock owner is not interrupted merely because an attempt is
slow. `fileErrors` lists up to 20 recoverable source access failures; correct
permissions or file availability, then rerun index. Failed directory/config
reads abort the attempt instead of silently removing dependent source.

Upgrade to migration 4 with `bun run db:migrate` before using durable progress.
No memory or graph records are rewritten by this additive migration.
Restart long-running MCP/watch sessions after upgrading so all processes use
the same parser, schema and progress behavior.

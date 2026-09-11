# Stable release acceptance

The current release remains alpha. A stable tag requires evidence for each open
item below; short smoke tests do not close long-duration or large-project gates.

| Gate | Evidence / remaining action |
| --- | --- |
| Project isolation and atomic graph publication | Existing integration and CLI/MCP tests |
| Watcher recovery | Bounded regressions plus five-minute own-repository simulation; multi-hour run still required |
| Daily MCP use | Project-only Codex/Claude installer, initialization instructions and standalone transport verification implemented; verify tools in a reloaded AI client |
| Setup and distribution | Pinned curl/PowerShell bootstrap with managed Docker/PostgreSQL implemented; interactive clean-machine acceptance, automatic connection upgrades and native binaries remain open |
| Large-project acceptance | Full parser, publication and SQL query sample on suitable hardware remains open |
| Memory behavior | Sampled parent/worker RSS available; sustained trend and total peak-memory acceptance remain open |
| DRY reporting | Exact-body candidate report implemented; semantic clone detection remains outside scope |
| Dead-code reporting | Conservative no-incoming-usage candidates implemented; entry-point reachability remains open |
| Release validation | Lint, typecheck, tests, build and hosted CI for the exact release commit |

Reports expose candidates and explicit limitations; they do not certify safe deletion or merging.

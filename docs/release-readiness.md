# Stable release acceptance

The current release remains alpha. A stable tag requires evidence for each open
item below; short smoke tests do not close long-duration or large-project gates.

| Gate | Evidence / remaining action |
| --- | --- |
| Project isolation and atomic graph publication | Existing integration and CLI/MCP tests |
| Watcher recovery | Bounded regressions plus five-minute own-repository simulation; multi-hour run still required |
| Daily MCP use | Project config generator, initialization instructions and standalone transport verification implemented; verify tools in a reloaded AI client |
| Setup and distribution | Source-checkout installation documented; a portable versioned installation/upgrade path remains open |
| Large-project acceptance | Full parser, publication and SQL query sample on suitable hardware remains open |
| Memory behavior | Sampled parent/worker RSS available; sustained trend and total peak-memory acceptance remain open |
| DRY reporting | Dedicated duplicate-body/candidate reporting not implemented |
| Dead-code reporting | Dedicated entry-point-aware candidate reporting not implemented; lack of callers is never automatic deletion approval |
| Release validation | Lint, typecheck, tests, build and hosted CI for the exact release commit |

DRY and dead-code reports are requested product additions. Their acceptance must
include evidence paths, relevant references, explicit uncertainty and regression
fixtures for entry points and callbacks. Reports should identify candidates for
review rather than silently deleting code. Until implemented, AI can use the
existing search and relationship tools for a manual review.

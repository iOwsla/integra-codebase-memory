# Implementation status

Release: **0.1.0-dev**. The supplied specifications are preserved under `docs/specifications/`; the project-isolation amendment takes precedence. This tracker distinguishes the implemented usable foundation from remaining release hardening. No v0.1.0 tag has been created.

| Phase | Status | Implementation and evidence |
| --- | --- | --- |
| 0 Workspace/tooling | DONE | Bun workspaces with declared dependencies, strict TypeScript, Biome, Vitest, Compose and CI configuration |
| 1 Domain/PostgreSQL | DONE | Explicit migrations, scoped composite constraints, transactional stores, persistent memory, advisory lock tests |
| 2 Scanner | DONE | Canonical roots, ignore/exclude pruning, binary/size/generated handling, symlink/nested repository exclusion, instrumented isolation tests |
| 3 TypeScript parser | IN PROGRESS | Usable static symbols/imports/calls/references/inheritance; fixtures cover core constructs, aliases, multiple configs and identity regression; exhaustive edge cases/workspace package resolution remain |
| 4 Index pipeline | DONE | Hash + parser/config/schema invalidation, no-op row preservation, selected-project conservative semantic re-analysis, deletion repair, atomic publication |
| 5 Search/graph | IN PROGRESS | Exact/prefix/trigram/lexical search, ambiguity, paging and bounded cycle-safe traversal implemented; query execution still loads a scoped snapshot |
| 6 Memory | IN PROGRESS | Create/search/archive/supersede and scope validation implemented; additional type/tag/scope search filters remain |
| 7 CLI | DONE | init/add/index/status/doctor/search/symbol/callers/callees/references/remember/memories/mcp/watch/clean/remove/debug |
| 8 MCP | DONE | Official SDK v2, 12 strict tools, readiness errors, bounded outputs, parser subprocess, no model-selected repository IDs |
| 9 Hardening | IN PROGRESS | A–J integration scenarios and real process lifecycle tests implemented; broader project/OS coverage remains |
| 10 Documentation/release | IN PROGRESS | README, ADRs, guides, issue template, changelog, limitations; hosted CI and release gate pending |

## Verification

Local environment: macOS arm64, Bun 1.3.3, TypeScript Compiler API 6.0.3, MCP server/client 2.0.0, Docker PostgreSQL 17 with pgvector.

Final verification results are recorded in `docs/verification.md`. Hosted CI has not been run by this task.

## Remaining work and next action

See `docs/limitations.md` for each incomplete requirement, current implementation and recommended next action. Prioritize additional parser/workspace resolution fixtures and scoped SQL query pagination before declaring production release readiness. Optional framework plugins, embeddings, cross-project memory and a daemon are intentionally not implemented.

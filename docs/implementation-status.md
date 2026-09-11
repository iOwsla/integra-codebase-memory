# Implementation status

Release: **0.1.0-alpha.13**. The supplied specifications are preserved under `docs/specifications/`; the project-isolation amendment takes precedence. This tracker distinguishes the implemented usable foundation from remaining release hardening. The alpha prerelease does not close the remaining production release gates.

| Phase | Status | Implementation and evidence |
| --- | --- | --- |
| 0 Workspace/tooling | DONE | Bun workspaces with declared dependencies, strict TypeScript, Biome, Vitest, Compose and CI configuration |
| 1 Domain/PostgreSQL | DONE | Explicit migrations, scoped composite constraints, transactional stores, persistent memory, advisory lock tests |
| 2 Scanner | DONE | Canonical roots, ignore/exclude pruning, binary/size/generated handling, symlink/nested repository exclusion, instrumented isolation tests |
| 3 TypeScript parser | DONE | v0.1 construct matrix, declared workspace exports/conditions, referenced custom configs, source redirects, CommonJS, accessor/overload regressions; see parser.md for evidence and explicit analysis limits |
| 4 Index pipeline | DONE | Hash + parser/config/schema invalidation, no-op row preservation, selected-project conservative semantic re-analysis, deletion repair, atomic publication |
| 5 Search/graph | DONE | Scoped SQL ranking/paging/snippets and bounded adjacency traversal; repeatable-read generation consistency, query timeouts and additive migration 2; see search.md |
| 6 Memory | DONE | SQL-paged type/tag/scope search, canonical scope validation, atomic symbol checks, concurrent supersede and retained history; CLI/MCP acceptance tests |
| 7 CLI | DONE | init/add/index/status/doctor/search/symbol/callers/callees/references/remember/memories/mcp/watch/clean/remove/debug |
| 8 MCP | DONE | Official SDK v2, 12 strict tools, readiness errors, bounded outputs, parser subprocess, no model-selected repository IDs |
| 9 Hardening | IN PROGRESS | Read-failure retry, durable stages, interrupted owner detection, active DB disconnect/SIGKILL recovery and compact manifests verified; call-owner regressions, isolated worker failure diagnostics and offline acceptance verified; phase profiling and allocation reductions added; bounded watcher bursts/retry/restart and changes queued during analysis covered; five-minute own-repository simulation restored the complete graph; long-duration and full large-file compiler performance remain open |
| 10 Documentation/release | IN PROGRESS | README, ADRs, guides, issue template, changelog, limitations; hosted Linux prerelease CI verified; project-only shell installer for Codex/Claude, MCP instructions and acceptance checklist added; stable-release hardening gates remain |

## Verification

Local environment: macOS arm64, Bun 1.3.3, TypeScript Compiler API 6.0.3, MCP server/client 2.0.0, Docker PostgreSQL 17 with pgvector.

Final verification results are recorded in `docs/verification.md`. Hosted Linux CI and the release workflow passed for v0.1.0-alpha.10; each subsequent release must pass its own gates.

## Remaining work and next action

See `docs/limitations.md` for each incomplete requirement, current implementation and recommended next action. Prioritize broader hardening and real-repository acceptance before declaring production release readiness. Optional framework plugins, embeddings, cross-project memory and a daemon are intentionally not implemented.

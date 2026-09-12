# CodeMemory roadmap

Our aim is to make project-specific code evidence easy for coding agents to retrieve, inspect and keep current. This roadmap describes priorities, not delivery dates or a promise of complete language coverage.

## Available in the alpha

- Project-bound MCP connections for Codex and Claude Code.
- JavaScript/TypeScript symbols, static relationships and focused source retrieval.
- Prisma schema graphs and model usage through supported static bindings.
- Explicit persistent project memory and bounded code-quality candidates.
- Shared CLI installation, registered-project updates and native Windows setup.
- Index progress, diagnostics, pagination and completed-generation queries.

## Next priorities

1. **Relationship correctness:** expand regression coverage for aliases, framework patterns and cross-program references; keep unresolved cases visible.
2. **Large-project acceptance:** measure full indexing, publication, query behavior and total worker memory on representative repositories and hardware.
3. **Efficient change handling:** reduce conservative project-wide re-analysis without losing dependent relationships.
4. **Reliable daily operation:** extend long-running watcher, restart, update and clean-machine installation acceptance.
5. **Clear evidence:** improve navigation and result completeness without hiding bounds or overwhelming the agent with source.

## Before a stable release

Every [release gate](docs/release-readiness.md) needs recorded evidence. Hosted CI and small fixtures do not replace long-duration or representative repository testing. The [implementation tracker](docs/implementation-status.md) contains engineering detail.

## Propose a direction

Open a [feature request](https://github.com/iOwsla/integra-codebase-memory/issues/new?template=feature_request.md) with the task you cannot complete, a small public example and the output you need. Language adapters and broader Prisma bindings need reproducible examples and tests; popularity alone does not establish correct analysis.

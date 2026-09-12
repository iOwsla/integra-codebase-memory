# CodeMemory documentation

CodeMemory provides local code intelligence and explicitly saved project memory through MCP. Start with a selected project, connect your coding client, then verify index status before querying.

## Start here

| Goal | Guide |
| --- | --- |
| Install, update or recover services | [CLI and installation](installation.md) |
| Preview project integration | [Project installer](setup/installer.md) |
| Connect an AI client | [Codex](setup/codex.md) · [Claude Code](setup/claude-code.md) |
| Add agent instructions | [AGENTS.md](instructions/AGENTS.md) · [CLAUDE.md](instructions/CLAUDE.md) |
| Understand the MCP interface | [Tools and protocol](mcp.md) |

## Use the graph

- [Prisma](prisma.md): schema relationships, model queries and supported client bindings.
- [Quality reports](quality-reports.md): dead-code and duplicate-code candidates.
- [Project memory](memory.md): requested facts, decisions, scope and history.
- [Search](search.md): result pages, query bounds and generation consistency.
- [Indexing](indexing.md): parser budgets, exclusions and diagnostics.

## Understand the implementation

- [Architecture](architecture.md) and [project isolation](project-isolation.md).
- [Parser coverage](parser.md), [plugins](plugins.md) and [limitations](limitations.md).
- [Verification evidence](verification.md) and [regression policy](regression-policy.md).
- [Implementation tracker](implementation-status.md), [roadmap](../ROADMAP.md) and [stable release gates](release-readiness.md).

## Releases and contribution

- [Published releases](https://github.com/iOwsla/integra-codebase-memory/releases) and [changelog](../CHANGELOG.md).
- [Contributing](../CONTRIBUTING.md) and [release-writing guide](releasing.md).
- [Security policy](../SECURITY.md).

- [Evidence-backed memory development and evaluation](memory-development.md)

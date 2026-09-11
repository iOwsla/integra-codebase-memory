# MCP v2 STDIO with immutable project context

## Context
Each client process must explicitly authorize one project, without accidental background global indexing.

## Decision
Use official `@modelcontextprotocol/server` and `client` 2.0.0. `serveStdio` owns negotiation and transport. Install transport before background indexing and return readiness errors until a snapshot exists. Scope is injected by the application service, never accepted in tool inputs.

## Alternatives
A global daemon and mutable active-project state would require additional authorization and lifecycle design.

## Consequences
A project needs one explicit absolute root per process. STDOUT contains only protocol frames; diagnostics use STDERR.

Reference: [official STDIO guide](https://github.com/modelcontextprotocol/typescript-sdk/blob/main/docs/serving/stdio.md).

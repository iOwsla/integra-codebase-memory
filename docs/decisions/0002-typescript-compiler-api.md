# TypeScript compiler API and bounded inputs

## Context
Structural edges must come from static analysis and must not cause scope expansion. TypeScript 7.0.2 no longer exposes the classic compiler API.

## Decision
Pin the supported API-compatible TypeScript 6.0.3 line. A hermetic CompilerHost reads scanned in-memory sources and in-scope config only. MCP parsing uses a Bun child process to avoid blocking transport initialization. Semantic re-analysis currently conservatively spans only the selected project.

## Alternatives
Unstable TypeScript 7 APIs, text matching and unrestricted compiler filesystem access were rejected.

## Consequences
External declarations are unresolved. No library allowlist is currently enabled. Future parser upgrades require regression tests and version-fingerprint invalidation.

References: [TypeScript 7 announcement](https://devblogs.microsoft.com/typescript/announcing-typescript-7-0/), [TypeScript 6 release notes](https://www.typescriptlang.org/docs/handbook/release-notes/typescript-6-0.html).

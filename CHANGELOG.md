# Changelog

## 0.1.0-alpha.1 — 2026-09-11

### Added
- Bun workspaces, strict TypeScript, Biome, Vitest and PostgreSQL/pgvector migrations.
- Explicit session project isolation, bounded scanning, semantic TypeScript plugin and atomic graph publication.
- Bounded search, callers/callees, references, traversal, file context, project memory, CLI and MCP v2.
- Process-owned watcher, reconciliation, advisory locks and real STDIO lifecycle tests.

- Phase 3: bounded custom configuration references, virtual package.json workspaces, conditional exports and unbuilt project-reference source redirects.
- Permanent construct coverage for generics, decorators, namespaces, chaining, CommonJS and alternate source extensions.

### Changed
- The project-isolation amendment supersedes global project selection and global memory access.
- TypeScript 6.0.3 supplies the stable Compiler API; MCP uses official v2 packages.

### Fixed
- Regression 001: variable-bound function expressions retain binding identity; same-named declarations in separate blocks no longer collapse.

- Regression 002: nested unresolved calls include both source-span boundaries in their identities, preventing duplicate-key publication failures.

- Idle PostgreSQL connection errors are handled and logged without crashing the process; forced-disconnect recovery is integration-tested.

- Regression 003: exported value/binding flags, full overload ranges, separate accessors and property-use references.
- Regression 004: static CommonJS imports/exports, with local-name shadowing protection.

### Removed
- No previous release.

### Known Issues
- See docs/limitations.md for static analysis limits and remaining query, memory and release hardening work.

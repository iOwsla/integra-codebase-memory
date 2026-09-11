# TypeScript parser acceptance — phase 3

Phase 3's v0.1 static-analysis scope is implemented. The language plugin supports JS, JSX, TS, TSX, MJS, CJS, MTS and CTS without executing source or building projects.

## Compiler configuration and workspace resolution

The scanner loads conventional tsconfig/jsconfig metadata and records eligible JSON paths. The language plugin proposes `references` and relative/absolute `extends` paths. Only JSON files already discovered inside the selected scope, not ignored/excluded/symlinked, and at most 64 KiB can be read. Cycles are visited once. Referenced custom names such as `compiler.json` and JSONC base configs are supported. Missing/out-of-scope configs produce diagnostics rather than additional filesystem discovery.

TypeScript parses compiler options and file membership. Source ownership prefers the deepest matching config, then an explicitly referenced config, then a conventional tsconfig, with a deterministic filename tie-break. Each symbol records its owning config in metadata. Source files not claimed by a configuration use the plugin's no-config defaults; scanner inclusion and compiler file membership are distinct.

`package.json` workspace patterns (array or `packages` form, including exclusions) create virtual in-memory package mounts. Only declared and already-scanned workspace packages are exposed. TypeScript's resolver handles package exports, conditional import/require branches, subpaths, wildcard subpaths and blocked exports. Duplicate package names produce a diagnostic and no mount. Physical node_modules trees and their symlinks remain unread.

For referenced declaration-producing projects, TypeScript's `getOutputFileNames` maps an unavailable in-scope declaration output to its accepted source file. This lets consumers resolve unbuilt references without reading or writing build artifacts. Ambiguous output mappings are refused. References outside the selected root never expand the source scope. No solution-builder or build scripts run.

## Construct and relationship evidence

Permanent fixtures and exact assertions cover:

- Functions, asynchronous/ordinary arrows and variable-bound function expressions.
- Classes, constructors, abstract/generic classes, static methods, class arrow fields and object methods.
- Interfaces, type aliases, enums, namespaces, nested functions and anonymous returns/default exports.
- Exported constants/variables, destructuring, overload source ranges and separate getter/setter identities.
- Named/default/namespace aliases, re-exports, local export aliases, dynamic imports and static CommonJS imports/exports.
- Decorator identifier references, optional calls, method chaining, circular imports and destructured receiver aliases.
- Compiler paths, multiple configs, custom referenced configs, conditional workspace exports and source redirects for unbuilt references.
- Missing/excluded/out-of-scope dependencies and local variables shadowing CommonJS names.

`CALLS` targets and ordinary references use TypeScript semantic resolution. Direct declarations/exports and unshadowed CommonJS export assignments are AST-confirmed. Unresolved/dynamic targets are retained rather than guessed. CommonJS export-object spreads, computed exports and runtime module loaders are not inferred.

## Remaining analysis limits

No external npm or standard-library declaration allowlist is enabled. Package config extends that are neither relative/absolute nor already captured conventional config files, pnpm YAML-only workspace declarations and runtime-generated package layouts may remain unresolved. A source shared by multiple compilation configurations has one deterministic owner; this is not a multi-configuration type-check report. Anonymous/block-local offsets can change identities when code moves. Dynamic dispatch, runtime mutation and implicit accessor invocations are not inferred as call edges.

These boundaries are explicit limitations of static v0.1 analysis, not a claim of exhaustive runtime knowledge. New real-repository defects still require fixture → failing test → fix → full validation.

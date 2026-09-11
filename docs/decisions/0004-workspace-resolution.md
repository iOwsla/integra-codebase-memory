# Bounded configuration discovery and virtual workspace resolution

## Context

Normal TypeScript module resolution follows node_modules and project declaration outputs. Unrestricted compiler reads would violate the selected-root boundary, while omitting workspace metadata loses statically resolvable callers.

## Decision

The scanner accepts plugin-proposed configuration references only from its already-discovered eligible JSON paths. The TypeScript plugin mounts declared in-scope workspace packages virtually in its in-memory compiler host. TypeScript itself chooses exports/conditions and resolves module paths. Referenced output paths are mapped to accepted sources using the compiler's output-name API. No build output or source outside the selected root is read.

## Alternatives

Following physical package-manager links expands authority. Manually resolving exports conditions would duplicate TypeScript's semantics. Requiring builds would execute project code and exclude fresh checkouts.

## Consequences

Fresh workspace checkouts and custom config references work without a build. Unknown/ambiguous/out-of-scope dependencies remain explicit. Alternate package-manager metadata can be added through the same bounded policy later.

Sources: [TypeScript module resolution](https://www.typescriptlang.org/docs/handbook/modules/reference.html), [project references](https://www.typescriptlang.org/docs/handbook/project-references.html).

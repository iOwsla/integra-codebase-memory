# Regression policy

Every discovered parser/indexing defect needs a permanent minimal fixture, an exact failing assertion, an implementation fix and a passing full suite. Do not patch only the user's real repository. Avoid proprietary code and secrets.

Regression 001 reproduces variable-bound function-expression identity and repeated names in separate blocks. The test was first observed failing before the implementation fix.

Run `bun run lint`, `bun run typecheck`, `bun run test`, `bun run build`. Integration tests use throwaway databases; E2E launches actual Bun CLI and official MCP client/server processes. Never mark a check passed solely because a command was submitted.

Regression 002 comes from indexing this repository: `external()()` created duplicate unresolved IDs. Its fixture and failing test preceded the source-span identity fix.

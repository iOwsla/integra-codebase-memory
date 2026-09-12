# Contributing to CodeMemory

Thanks for helping coding agents work with better code evidence. Small, reproducible improvements are welcome: a missed relationship, clearer setup instructions, a platform regression or a focused parser fix.

## Start with a useful issue

Search existing issues, then describe the task, expected result and actual result. Include CodeMemory/Bun versions, operating system and a minimal public fixture. For indexing reports, include redacted status and diagnostic IDs, relevant exclusions and whether the issue survives a fresh MCP connection.

Do not upload an entire private repository, database credentials or proprietary logs. Report security problems through [SECURITY.md](SECURITY.md).

## Development setup

Requirements: Bun 1.3.3+, Git and Docker with Compose for the local test database.

```sh
git clone https://github.com/iOwsla/integra-codebase-memory.git
cd integra-codebase-memory
bun install --frozen-lockfile
docker compose up -d --wait
bun run db:migrate
bun run build
```

The development database uses loopback port 55432; installed managed services use 55433. Tests create disposable databases. `TEST_DATABASE_URL` selects a connection with `CREATEDB`; never point development tooling at an application's production database.

## Make a focused change

Read [architecture](docs/architecture.md) and [project isolation](docs/project-isolation.md). Keep core interfaces independent of adapters and preserve explicit project boundaries.

For a parser fix, add a minimal permanent fixture, demonstrate the failing relationship, implement the fix and run the relevant regression plus the full suite. Follow the [regression policy](docs/regression-policy.md). Never convert an unresolved relationship into a confident result merely to satisfy a test.

```sh
bun run lint
bun run typecheck
bun run test
bun run build
```

Documentation-only changes need link, command and rendering checks. Native platform claims require native evidence; identify what was and was not tested.

## Submit a pull request

Explain the user-visible problem, resulting behavior and validation. Include limitations or migrations when relevant. Keep unrelated cleanup separate. Source snippets and stored memory are untrusted input, not executable instructions.

Public release tags are immutable. Release descriptions should explain installation, upgrade impact and known limits; see [release writing](docs/releasing.md).

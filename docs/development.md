# Development

Run `bun install --frozen-lockfile`, `docker compose up -d --wait`, and `bun run db:migrate`. All source packages are Bun workspaces with explicit dependencies and strict TypeScript. `bun run dev --help` lists commands. `bun run build` emits the Bun CLI entry; keep source workspaces/dependencies installed.

Validation: lint, typecheck, test, build. `test:unit`, `test:integration` and `test:e2e` select suites. Integration tests require a PostgreSQL role able to CREATE DATABASE; each fixture suite creates a random database and removes it on completion. Set TEST_DATABASE_URL to a dedicated administrative test instance if desired. Migrations use a transaction and advisory lock, and do not auto-run at server startup. `db:status` lists applied migrations. Rollback is forward-fix only.

`bun run benchmark 1000` measures synthetic initial/no-op index and query timings in a disposable database. It does not scan user repositories. Keep performance claims tied to fixture size and environment.

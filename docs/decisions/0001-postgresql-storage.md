# PostgreSQL publication and scoped keys

## Context
Concurrent sessions must not expose half-written or cross-project graphs.

## Decision
Use PostgreSQL with explicit forward migrations, composite scope/entity foreign keys, project advisory locks, and one transactional graph publication. Read complete snapshots under REPEATABLE READ. Memory has an independent lifecycle.

## Alternatives
File snapshots simplify installation but make query evolution and multi-process writes harder. Per-file commits alone can expose mixed graphs.

## Consequences
PostgreSQL is required. Initial query implementation loads project snapshots; SQL query paging is a release hardening milestone.

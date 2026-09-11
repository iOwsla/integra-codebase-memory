# Explicit project memory

Supported types: FACT, DECISION, WARNING, NOTE, CONVENTION, INCIDENT, TODO.
Scopes are repository, directory, file and symbol; global scope is rejected.
Content is explicitly supplied, not inferred from code or automatically created.

`remember` creates a record. `supersedes` transactionally replaces an ACTIVE
same-project record and links it to the new one; the old record remains
SUPERSEDED. Concurrent replacements of the same record allow only one winner.
CLI `memories --archive <id>` archives a same-project record. Search defaults to
ACTIVE records; `includeInactive` also returns ARCHIVED and SUPERSEDED history.

## Filters and pages

`search_memory` accepts these fields in addition to the optional literal `query`:

- `types`: match any of the selected types; empty means every type.
- `tags`: require all selected tags, with exact case-sensitive matching.
- `scope`: `{type, target?}`; omitted target filters by scope type alone. A target
  matches that exact scope identity, not descendant paths or inherited scopes.
  Repository scope never accepts a target.
- `includeInactive`: false by default.
- `limit`: 1–100 (default 20); `offset`: 0–100000 (default 0).

Filters combine with AND. Text search remains a case-insensitive literal
substring of title, content and space-separated tags. Percent, underscore and
backslash characters are literal. Newest creation time sorts first, with ID as a
stable tie-breaker. Priority is stored but does not alter this ordering.

SQL selects at most `limit + 1` records and returns `results`, `hasMore` and
`nextOffset`. Search works before code indexing and never loads a full memory
or code snapshot. A five-second SQL timeout bounds database work; broad text
queries may still scan many scoped records. Separate pages can shift when
memories are created or archived between requests; there is no cursor snapshot.

## Scope lifecycle

New file/directory memories require an existing target of the correct type,
inside the selected project and outside excluded source boundaries. Paths are
stored relative to the canonical project root (`.` for the root directory).
Symbol existence is checked with a scoped row lock in the insert transaction;
foreign or missing symbol IDs are rejected. Code deletion later does not delete
these memories or automatically reattach them to a renamed symbol.

Search filters check path boundaries lexically without reading source files, so
memories remain searchable after deletion. Use the stored canonical target for
symlink aliases. Older records retain their original target text: canonical,
absolute, `./` and the exact supplied legacy spelling are accepted when
filtering. Other historical spellings may require supplying their stored value.
No migration rewrites memory content or scope identities.

`clean --yes` deletes only code index data; memory survives. `remove --yes`
removes the selected project and its memories. These operations remain scoped.

## CLI examples

```sh
bun run dev remember --project /absolute/project --type WARNING \
  --title 'API rule' --content 'Keep this response compatible.' \
  --scope file --target src/api.ts --tag api --tag compatibility

bun run dev memories --project /absolute/project --type WARNING --type DECISION \
  --tag api --scope file --target src/api.ts --limit 10 --offset 0

bun run dev remember --project /absolute/project --title 'Updated rule' \
  --content 'Replacement guidance.' --supersedes MEMORY_ID

bun run dev memories --project /absolute/project --include-inactive
```

Migration 3 adds memory filter/paging indexes. Run `bun run db:migrate` when
upgrading. Index creation can lock busy tables; choose an appropriate maintenance
window. Existing records are preserved and migration reruns are idempotent.

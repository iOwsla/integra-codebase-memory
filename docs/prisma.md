# Prisma schema and usage indexing

Prisma analysis is included in the normal scanner and parser from alpha.19.
Eligible `.prisma` files follow the same project boundary, ignore rules, size
limits and watcher lifecycle as TypeScript sources. No Prisma CLI, generator,
application code or application database is executed or contacted. The parser
uses the pinned [Prisma schema parser](https://github.com/loancrate/prisma-schema-parser)
for a located syntax tree; it does not perform Prisma's database-specific validation.

## Schema graph

Search with `search_symbols({"query":"User","kinds":["MODEL"]})`, then use the
returned ID with `get_symbol`. The declaration retains its actual schema name;
`@@map` and `@map` are metadata, not replacements for client-facing names.

- Models/views: `MODEL`; fields/enum values: `FIELD`; enums: `ENUM`.
- Composite types: `TYPE_ALIAS` with `declarationKind: "type"`.
- `DECLARES`: file to model, model to field.
- `RELATES_TO`: model to related model, including implicit many-to-many fields.
- `RELATION_MODEL`: relation field to target model.
- `FOREIGN_KEY`: each local scalar field to its referenced scalar field, including compound keys.
- `TYPE_OF`: fields to enum/composite declarations.

Field metadata preserves optional/list types, named relation arguments,
`fields`, `references`, referential actions, mappings and attributes. Syntax
errors include locations; missing/ambiguous schema types and invalid referenced
field names produce diagnostics. Valid schema files remain queryable.

Schema files underneath a single generator directory form a group. Separate
same-directory generator files are kept separate. Standard `@prisma/client`
imports require one unambiguous matching client group in the importing file's
nearest scanned package. Custom generator outputs support relative imports of
the output directory, `client` or `index` entry. Multiple possible clients are not
merged on model name. Nonstandard schema folder/config mappings need explicit
future support; `prisma.config.ts` is never executed.

## Model usage without a fixed variable name

```ts
import { PrismaClient as Engine } from '@prisma/client';
const database = new Engine();
const { user: accounts } = database;
const user = accounts;
export function loadUsers() {
  return user.findMany({ where: { email: 'example' } });
}
```

The resolver follows the imported constructor and model delegate through lexical
`const` aliases, destructuring and statically resolved local imports/re-exports.
Unshadowed CommonJS `require` imports of PrismaClient are also supported.
It also supports extracted query methods, client properties with imported
PrismaClient types, `Prisma.UserDelegate` types and interactive transaction
parameters. A variable merely named `user`, `prisma` or `db` is insufficient.
Mutable aliases, arbitrary factories, dependency-injection runtime containers,
client extensions and ambiguous imports are not inferred from spelling.

`find_references({"symbolId":"<User model ID>"})` returns incoming usage edges
with the calling symbol, file, call line and `metadata.operation`, such as
`findMany`, `count`, `create`, `update` or `delete`. Follow `hasMore`/`nextOffset`.
`PRISMA_QUERY` edges expose the same calls to `trace_dependencies`; use
`edgeTypes: ["PRISMA_QUERY"]` for model consumers or `["RELATES_TO"]` for schema
relationships. Multiple schemas may declare `User`; select the correct file/ID.

Literal `where`, `select`, `include`, `data` and nested relation argument objects
also create field references. Dynamic arguments, spreads, computed keys and
arbitrary wrappers are not complete field coverage. Dynamic operations and
unsupported methods on proven receivers produce unresolved records. Raw SQL,
query results and runtime model names are not parsed into model relationships.
Missing references never establish unused models or fields.

## Storage, speed and upgrades

Schema symbols and usage edges use the existing project-scoped PostgreSQL tables.
The physical `edges_in`/`edges_in_page` and outgoing indexes support model lookup;
no new migration or application database index is required. A disposable-database
regression checks the actual query plan with 10,000 relationships. This is not a
production latency guarantee or a large-monorepo concurrency benchmark.

After updating, reconnect MCP or run `codememory index` in the selected project.
The parser revision changes, so old graphs are rebuilt on the next index. Only
then will Prisma symbols and usages appear. `codebase_status.analysisScope`
includes Prisma and `.prisma`; check diagnostics and generation freshness.

## Block comments

From alpha.22, `/* ... */` and `/** ... */` comments are accepted through a
compatibility adapter for the upstream parser. Only the parser's in-memory input
is masked with spaces; original source, LF/CRLF line endings and UTF-16 source
positions are preserved. Delimiters inside quoted strings or line comments stay
untouched. Unterminated comments remain syntax errors. Comment text remains in
source previews; this adapter does not attach block documentation to AST nodes.

After updating, parser revision 8 triggers re-analysis even when source files
have not changed. Reconnect the selected project's MCP session, wait for its
index and check diagnostics before reusing model IDs.

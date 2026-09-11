# CODEBASE MEMORY

## Production-Grade Local Code Intelligence & Persistent Project Memory System

You are the principal software architect and implementation engineer responsible for building this project from scratch.

Your job is NOT to create a proof of concept.

Your job is to create a clean, extensible, production-quality foundation that we can actively use on real repositories and improve incrementally as bugs and edge cases are discovered.

Do not attempt to support every programming language or framework immediately.

The philosophy of this project is:

> Start small, architect correctly, use it on real codebases, find edge cases, write regression tests, fix them, and continuously improve the system.

The first stable target is JavaScript / TypeScript / TSX.

The architecture MUST allow additional language and framework plugins later without rewriting the core.

---

# 1. PRODUCT GOAL

Build a local-first codebase intelligence system that indexes source repositories and exposes structural knowledge to AI coding agents through MCP.

The system must allow AI agents such as:

* Codex
* Claude Code
* Cursor
* VS Code agents
* Any MCP-compatible agent

to understand a codebase without repeatedly reading the entire repository.

The system must provide:

1. Repository indexing
2. File metadata
3. Symbol extraction
4. Symbol relationships
5. Import relationships
6. Call relationships
7. References
8. Search
9. Code graph queries
10. Persistent project memory
11. Incremental re-indexing
12. MCP tools
13. CLI management
14. Diagnostics
15. Plugin architecture
16. Regression test infrastructure

The system should eventually answer questions such as:

```text
Where is createOrder defined?

Who calls completeOrder?

What functions does completeOrder call?

Where is OrderService used?

Which files import order.service.ts?

What code references stock_movements?

Trace the flow from POST /orders/:id/complete to StockService.

Which functions changed recently?

What architectural decisions have been stored for this repository?

What warnings should I know before modifying this module?
```

Do NOT use LLM inference as the source of truth for structural code relationships.

Structural relationships must come from static analysis wherever possible.

---

# 2. CORE DESIGN PRINCIPLES

The project must follow these principles.

## 2.1 AST first

Code structure must be extracted from syntax/semantic analysis rather than guessed using embeddings or LLMs.

Example:

```ts
orderService.completeOrder(orderId);
```

should produce an edge similar to:

```text
CURRENT_SYMBOL
    --CALLS-->
OrderService.completeOrder
```

if it can be statically resolved.

---

## 2.2 Explicit confidence

Not every relationship can always be resolved with absolute certainty.

Each graph relationship must have a confidence/source classification.

At minimum:

```text
AST_CONFIRMED
SEMANTIC_CONFIRMED
HEURISTIC
UNRESOLVED
```

Internally numeric confidence may also be stored:

```text
1.00
0.95
0.70
0.00
```

Never pretend a heuristic relationship is guaranteed.

---

## 2.3 Local first

The application must work without requiring a cloud AI provider.

The core functionality must work with:

* repository parsing
* graph search
* symbol search
* lexical code search
* memory search

without calling external APIs.

Embeddings must be optional.

---

## 2.4 Incremental indexing

Never re-index an entire repository because one source file changed.

Maintain file hashes.

If:

```text
src/orders/order.service.ts
```

changes, invalidate/rebuild only the data belonging to that file and any relationships that require dependency re-resolution.

---

## 2.5 Replaceable infrastructure

Avoid hard coupling between core logic and:

* PostgreSQL
* embeddings
* TypeScript parser
* MCP transport
* filesystem watcher

Use clear interfaces.

---

## 2.6 Plugins

Language-specific and framework-specific knowledge must live outside the core.

The core must not contain hard-coded knowledge about:

```text
Prisma
NestJS
Express
Elysia
Next.js
Socket.IO
React
```

These should eventually be plugins.

---

## 2.7 Regression-driven development

Whenever a parsing/indexing bug is discovered:

1. Reproduce the bug with a fixture.
2. Add a failing regression test.
3. Fix the implementation.
4. Verify all previous tests.
5. Keep the fixture permanently.

Never fix parser edge cases without a regression test.

---

# 3. TECHNOLOGY STACK

Use:

```text
Runtime:
Bun

Language:
TypeScript

TypeScript:
strict mode enabled

MCP:
Official Model Context Protocol TypeScript SDK v2

Packages:
@modelcontextprotocol/server
@modelcontextprotocol/client

Primary database:
PostgreSQL

Vector extension:
pgvector

Testing:
Vitest unless Bun's built-in test runner provides a materially simpler solution.
Prefer one consistent test framework.

File watcher:
chokidar or an equivalent robust cross-platform solution.

Parsing:
TypeScript Compiler API for JS/TS/TSX semantic analysis.

Optional future parsing:
Tree-sitter through LanguagePlugin adapters.

Git:
Use git CLI through a controlled adapter rather than implementing git internals.

Validation:
Zod v4 or another Standard Schema compatible validator.

CLI:
TypeScript CLI running with Bun.
```

Use currently supported stable package versions at implementation time.

Do NOT blindly copy old examples using deprecated MCP SDK APIs.

Before implementing the MCP layer, inspect the current official MCP TypeScript SDK v2 documentation.

---

# 4. REPOSITORY STRUCTURE

Create a Bun workspace/monorepo.

Suggested structure:

```text
codebase-memory/
│
├── apps/
│   └── cli/
│
├── packages/
│   ├── core/
│   ├── database/
│   ├── indexer/
│   ├── graph/
│   ├── search/
│   ├── memory/
│   ├── mcp-server/
│   ├── plugin-sdk/
│   ├── plugin-typescript/
│   ├── shared/
│   └── test-utils/
│
├── plugins/
│   └── framework/
│       └── README.md
│
├── tests/
│   ├── integration/
│   ├── e2e/
│   └── fixtures/
│
├── scripts/
│
├── docker/
│
├── docs/
│
├── docker-compose.yml
├── package.json
├── bunfig.toml
├── tsconfig.base.json
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
└── LICENSE
```

If implementation reveals a cleaner structure, improve it.

However, maintain strict separation between:

```text
core domain
storage
parser/indexer
MCP
CLI
plugins
```

---

# 5. PACKAGE RESPONSIBILITIES

## packages/core

Contains domain types and application interfaces.

Must NOT know about PostgreSQL or MCP.

Examples:

```ts
Repository
IndexedFile
Symbol
SymbolEdge
MemoryEntry
IndexJob
SearchQuery
SearchResult
```

Define interfaces for:

```ts
RepositoryStore
FileStore
SymbolStore
EdgeStore
MemoryStore
SearchProvider
EmbeddingProvider
LanguagePlugin
FrameworkPlugin
FileHasher
FileScanner
GitProvider
```

---

# 6. DOMAIN MODEL

## Repository

Suggested properties:

```ts
interface Repository {
  id: string;
  name: string;
  rootPath: string;
  normalizedRootPath: string;

  defaultBranch?: string;

  createdAt: Date;
  updatedAt: Date;
  lastIndexedAt?: Date;

  status:
    | "NEW"
    | "INDEXING"
    | "READY"
    | "ERROR";
}
```

---

# 7. FILE MODEL

Each indexed file should contain at least:

```text
id
repository_id

relative_path
absolute_path

language

size_bytes

content_hash

git_ignored

generated

binary

last_modified_at
last_indexed_at

parser_version

index_status
index_error
```

Do NOT persist absolute paths inside data that may later be exported unless necessary.

Prefer repository-relative paths for user-facing output.

---

# 8. SYMBOL MODEL

A Symbol represents an addressable code element.

Supported v0.1 symbol kinds:

```text
FILE
MODULE
FUNCTION
METHOD
CLASS
INTERFACE
TYPE_ALIAS
ENUM
VARIABLE
CONSTANT
PROPERTY
CONSTRUCTOR
IMPORT
EXPORT
```

Symbol fields:

```text
id

repository_id
file_id

kind

name
qualified_name

start_line
start_column

end_line
end_column

signature

visibility

exported

async

static

content_hash

metadata JSONB
```

Use deterministic IDs where practical.

For example:

```text
repository-id
+
file path
+
symbol kind
+
qualified name
```

hashed into a stable identifier.

This prevents unnecessary identity churn after reindexing.

---

# 9. QUALIFIED NAMES

Generate useful qualified names.

Example:

```ts
export class OrderService {
  async completeOrder() {}
}
```

Could become:

```text
OrderService
OrderService.completeOrder
```

Where namespaces/modules matter, preserve them.

Qualified names should remain stable unless the actual logical symbol changes.

---

# 10. GRAPH MODEL

Relationships between symbols/files are stored as directed edges.

Required edge types:

```text
IMPORTS
EXPORTS
RE_EXPORTS

CALLS

REFERENCES

EXTENDS
IMPLEMENTS

DECLARES

READS
WRITES

DEPENDS_ON
```

Not all edge types must be fully implemented in v0.1.

At minimum implement reliably:

```text
IMPORTS
EXPORTS
CALLS
REFERENCES
EXTENDS
IMPLEMENTS
DECLARES
```

Edge schema:

```text
id

repository_id

source_symbol_id
target_symbol_id

edge_type

confidence

resolution_method

source_file_id

metadata JSONB

created_at
updated_at
```

---

# 11. UNRESOLVED REFERENCES

Do not silently discard unresolved calls/imports.

Create an unresolved reference representation when appropriate.

Example:

```ts
someDynamicObject.run()
```

could not be resolved.

Store enough information to later inspect:

```text
source symbol
expression
file
line
candidate name
reason resolution failed
```

This will be extremely useful when improving the parser.

---

# 12. TYPESCRIPT LANGUAGE PLUGIN

Create:

```text
packages/plugin-typescript
```

The TypeScript plugin must support:

```text
.js
.jsx
.ts
.tsx
.mjs
.cjs
.mts
.cts
```

Use TypeScript Compiler API.

The plugin should:

```text
create program
load tsconfig where available
resolve compiler options
parse source files
walk AST
extract symbols
resolve imports
resolve aliases
resolve references
resolve function calls where possible
resolve inheritance
resolve implementations
```

Support repositories with:

```text
tsconfig.json
multiple tsconfigs
workspace packages
path aliases
baseUrl
project references
```

Do not assume every repository has a tsconfig.

Gracefully fall back to sensible defaults.

---

# 13. IMPORTANT TYPESCRIPT EDGE CASES

Tests must cover:

```ts
function foo() {}

const foo = () => {};

const foo = async () => {};

export default function foo() {}

export const foo = () => {};

class Foo {
  bar() {}
}

class Foo {
  static bar() {}
}

abstract class Foo {}

interface Foo {}

type Foo = {};

enum Foo {}

const obj = {
  foo() {}
};

function factory() {
  return () => {};
}
```

Also cover:

```text
function overloads
anonymous functions
nested functions
generics
decorators
aliases
re-exports
barrel files
default imports
named imports
namespace imports
dynamic imports
circular imports
optional chaining
method chaining
destructuring
monorepos
symlinked packages
```

---

# 14. IMPORT RESOLUTION

Resolve imports such as:

```ts
import { foo } from "./foo";
```

```ts
import { foo } from "@/services/foo";
```

```ts
import foo from "@company/shared";
```

Use TypeScript module resolution where possible.

Do not manually reinvent module resolution.

Differentiate:

```text
internal repository dependency

workspace dependency

external npm dependency
```

External dependencies do NOT need their source code indexed during v0.1.

But references to them may be stored as external dependency nodes.

---

# 15. FILE SCANNER

The scanner must respect:

```text
.gitignore
```

Also apply default exclusions:

```text
.git
node_modules
dist
build
coverage
.next
.nuxt
out
vendor
.tmp
.cache
```

Allow configuration overrides.

Never index by default:

```text
.env
.env.*
*.pem
*.key
*.p12
*.pfx
credentials.*
secrets.*
```

Never expose secret files through MCP.

---

# 16. BINARY FILE DETECTION

Detect binary files.

Do not attempt to AST parse or text-index binary content.

Examples:

```text
images
videos
fonts
archives
compiled binaries
database files
```

---

# 17. GENERATED CODE

Attempt to detect generated code through:

```text
path conventions
file comments
known generated directories
configuration
```

Store:

```text
generated = true
```

Generated code may be indexed structurally but should receive lower search priority by default.

Allow:

```text
--exclude-generated
```

and configuration.

---

# 18. FILE SIZE PROTECTION

Do not accidentally load enormous files into memory.

Use configurable limits.

Example default:

```text
max source file:
2 MB
```

If exceeded:

```text
mark SKIPPED_TOO_LARGE
```

and report it through diagnostics.

---

# 19. HASHING

Calculate a cryptographic or robust deterministic content hash.

Example:

```text
SHA-256
```

Indexing logic:

```text
current hash == stored hash
→ skip parsing

current hash != stored hash
→ re-index
```

---

# 20. INCREMENTAL INDEXING PIPELINE

Implement the pipeline in stages.

Conceptually:

```text
DISCOVER
↓
FILTER
↓
HASH
↓
PARSE
↓
EXTRACT SYMBOLS
↓
RESOLVE RELATIONSHIPS
↓
WRITE DATABASE
↓
UPDATE SEARCH INDEX
↓
COMPLETE
```

Changes to one file should use a database transaction.

Never leave half-indexed file state.

---

# 21. FILE DELETION

When an indexed source file is deleted:

Remove or invalidate:

```text
file record
symbols
outgoing edges
incoming edges where appropriate
search chunks
```

Do not leave ghost symbols.

---

# 22. FILE RENAMES

Attempt to detect renames through Git when possible.

A rename should ideally preserve logical history.

However correctness is more important than clever rename detection.

If uncertain, treating it as:

```text
delete old
+
create new
```

is acceptable initially.

---

# 23. WATCH MODE

Command:

```bash
codememory watch .
```

Watch filesystem changes.

Debounce rapid writes.

Example:

```text
change
change
change
change
```

during editor save operations should result in one indexing job.

Prevent duplicate concurrent indexing of the same file.

---

# 24. CONCURRENCY

Use a bounded worker queue.

Never launch unbounded parsing tasks.

Configuration example:

```text
indexConcurrency: 4
```

Make defaults configurable.

---

# 25. DATABASE

Use PostgreSQL.

Provide:

```text
docker-compose.yml
```

for local development.

Include pgvector extension.

Create migrations.

Do not use schema synchronization that silently changes production schema.

All schema changes must use migrations.

---

# 26. DATABASE TABLES

At minimum:

```text
repositories

files

symbols

symbol_edges

unresolved_references

memories

index_runs

index_errors

settings
```

Optional:

```text
search_chunks
embeddings
git_commits
```

---

# 27. DATABASE INDEXES

Add indexes intentionally.

Examples:

```text
files(repository_id, relative_path)

symbols(repository_id, name)

symbols(repository_id, qualified_name)

symbols(file_id)

symbol_edges(source_symbol_id)

symbol_edges(target_symbol_id)

symbol_edges(edge_type)

memories(repository_id)

memories(type)
```

Consider trigram indexes for fuzzy symbol search.

Use PostgreSQL FTS where appropriate.

---

# 28. SEARCH ARCHITECTURE

Search must NOT depend on embeddings.

Implement layers.

## Exact symbol search

Highest priority.

Example:

```text
completeOrder
```

should find an exact symbol before fuzzy matches.

---

## Prefix search

Example:

```text
completeOrd
```

---

## Fuzzy search

Use PostgreSQL trigram or equivalent.

---

## Lexical content search

Search indexed textual content.

Use PostgreSQL FTS where appropriate.

---

## Optional semantic search

Create an abstraction:

```ts
interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}
```

Initial providers may include:

```text
disabled
OpenAI-compatible endpoint
Ollama-compatible endpoint
```

However:

The entire product MUST remain useful when embeddings are disabled.

---

# 29. SEARCH RESULT SCORING

Rank results using weighted scoring.

Conceptually:

```text
exact symbol match
>
qualified symbol match
>
prefix match
>
reference match
>
fuzzy name match
>
lexical content
>
generated code
```

Generated code should receive a score penalty.

Return score explanations during debug mode.

---

# 30. CODE CHUNKS

If content chunks are implemented:

Never blindly split every N characters.

Prefer semantic boundaries:

```text
function
class
method
interface
top-level declaration
```

Fallback to bounded line windows.

Include metadata:

```text
file
start line
end line
owning symbol
```

---

# 31. PROJECT MEMORY

This system must contain persistent project memory separately from code graph data.

Memory is NOT the same as indexed code.

Memory types:

```text
FACT
DECISION
WARNING
NOTE
CONVENTION
INCIDENT
TODO
```

Memory record:

```text
id

repository_id

scope

type

title

content

tags

priority

status

source

created_at
updated_at
```

Status:

```text
ACTIVE
SUPERSEDED
ARCHIVED
```

---

# 32. MEMORY SCOPE

Support:

```text
repository
directory
file
symbol
global
```

Examples:

```text
Repository-level:
Business day starts at 04:00.

Directory-level:
All API handlers in /modules/payments use PaymentService.

File-level:
Do not directly modify this generated adapter.

Symbol-level:
OrderService.completeOrder must remain idempotent.
```

---

# 33. MEMORY SHOULD BE EXPLICIT IN V0.1

Do NOT automatically let an LLM populate the memory database.

Memory creation must happen through explicit commands/tools.

This prevents low-quality memory accumulation.

Later we may add:

```text
memory suggestions
```

but suggestions must require approval.

---

# 34. MEMORY VERSIONING

When replacing a decision:

Do not silently delete the old decision.

Allow:

```text
old memory
status = SUPERSEDED
```

and link:

```text
superseded_by
```

where useful.

---

# 35. CLI

Create executable:

```text
codememory
```

Commands:

```bash
codememory init

codememory add <path>

codememory remove <repository>

codememory index [path]

codememory watch [path]

codememory status

codememory doctor

codememory search <query>

codememory symbol <name>

codememory callers <symbol>

codememory callees <symbol>

codememory references <symbol>

codememory remember

codememory memories

codememory mcp

codememory clean
```

Provide:

```bash
codememory --help
```

and command-specific help.

---

# 36. INIT COMMAND

```bash
codememory init
```

Should:

1. Detect repository root.
2. Detect Git.
3. Detect languages.
4. Detect tsconfig.
5. Create `.codememory/` when needed.
6. Create project config.
7. Register repository.
8. Explain next action.

Example:

```text
CodeMemory initialized.

Repository:
my-project

Root:
/projects/my-project

Detected:
TypeScript
Git
tsconfig.json

Next:

codememory index .
```

---

# 37. PROJECT CONFIG

Support:

```text
.codememory/config.json
```

or equivalent.

Example conceptual configuration:

```json
{
  "version": 1,
  "index": {
    "include": [
      "src/**/*"
    ],
    "exclude": [
      "**/*.generated.ts"
    ],
    "maxFileSizeBytes": 2097152,
    "concurrency": 4
  },
  "search": {
    "generatedCodePenalty": 0.5
  },
  "watch": {
    "debounceMs": 300
  }
}
```

Validate configuration.

Show useful errors.

---

# 38. DOCTOR COMMAND

This command is essential.

```bash
codememory doctor
```

Check:

```text
runtime

database connection

database migrations

pgvector extension

repository accessibility

git availability

tsconfig readability

parser availability

MCP server health

configuration

filesystem permissions

stale indexing jobs
```

Example:

```text
CodeMemory Doctor

✓ Bun runtime
✓ PostgreSQL connection
✓ Database migrations
✓ pgvector extension
✓ Repository readable
✓ Git available
✓ TypeScript parser

⚠ 3 files exceeded size limit
✗ 1 stale index job

Run:
codememory doctor --repair
```

Repair only safe conditions.

Never perform destructive repair silently.

---

# 39. STATUS COMMAND

Example:

```text
Repository: api

Status: READY

Files discovered: 2,481
Files indexed: 1,932
Files skipped: 549

Symbols: 18,442
Edges: 63,291
Unresolved references: 1,202

Last full index:
2026-09-11 10:42

Last incremental update:
2026-09-11 11:03

Watcher:
ACTIVE
```

---

# 40. MCP SERVER

Use the official MCP TypeScript SDK v2.

Support STDIO first.

Command:

```bash
codememory mcp
```

STDOUT must be reserved for MCP protocol communication.

Send diagnostics/logging to STDERR.

This is critical.

Never corrupt MCP STDIO with normal console logs.

---

# 41. MCP TOOL DESIGN

MCP tools should return bounded structured results.

Do not dump huge files into context by default.

Required v0.1 MCP tools:

```text
codebase_status

search_symbols

search_code

get_symbol

get_file_outline

get_file_context

find_references

find_callers

find_callees

trace_dependencies

remember

search_memory
```

Optional:

```text
get_recent_changes
```

---

# 42. TOOL: codebase_status

Returns:

```text
repository
index state
file count
symbol count
edge count
last indexing time
watch state
errors
```

---

# 43. TOOL: search_symbols

Input:

```json
{
  "query": "completeOrder",
  "kinds": [
    "METHOD",
    "FUNCTION"
  ],
  "limit": 20
}
```

Result:

```json
{
  "results": [
    {
      "symbolId": "...",
      "name": "completeOrder",
      "qualifiedName": "OrderService.completeOrder",
      "kind": "METHOD",
      "file": "src/orders/order.service.ts",
      "line": 72
    }
  ]
}
```

---

# 44. TOOL: get_symbol

Input:

```json
{
  "symbolId": "..."
}
```

Return:

```text
symbol identity
signature
location
parent symbol
documentation
small code excerpt
incoming relationship counts
outgoing relationship counts
```

Keep snippets bounded.

---

# 45. TOOL: find_references

Return references with:

```text
file
line
owning symbol
reference type
confidence
```

Support pagination/limit.

---

# 46. TOOL: find_callers

Input can preferably use symbol ID.

Names may be ambiguous.

When the caller provides a name that resolves to multiple symbols:

Return candidates instead of guessing.

This is extremely important.

---

# 47. TOOL: find_callees

Same ambiguity rules as find_callers.

Return:

```text
callee
location
confidence
resolution method
```

---

# 48. TOOL: get_file_outline

Given:

```text
src/orders/order.service.ts
```

return compact structure:

```text
OrderService

  constructor
  createOrder
  completeOrder
  cancelOrder

OrderOptions
OrderResult
```

Avoid returning entire file.

---

# 49. TOOL: get_file_context

Return a bounded range around a symbol or line.

Inputs:

```text
path
line
before
after
```

Enforce maximum context size.

Prevent accidental 30,000-line responses.

---

# 50. TOOL: search_code

Search both symbol metadata and indexed textual content.

Return:

```text
file
lines
symbol
snippet
score
match reason
```

Never return entire files.

---

# 51. TOOL: trace_dependencies

This should eventually become one of the most useful tools.

Input:

```json
{
  "fromSymbolId": "...",
  "direction": "outgoing",
  "maxDepth": 5
}
```

Return bounded graph paths.

Example:

```text
OrderController.complete
→ OrderService.completeOrder
→ StockService.deduct
→ StockRepository.createMovement
```

Protect against cycles.

Inputs:

```text
maxDepth
maxPaths
edgeTypes
```

must have safe defaults and hard maximums.

---

# 52. TOOL: remember

Input:

```json
{
  "type": "DECISION",
  "title": "Business day calculation",
  "content": "Business day begins at 04:00.",
  "scope": {
    "type": "repository"
  },
  "tags": [
    "orders",
    "reporting"
  ]
}
```

Return memory ID.

---

# 53. TOOL: search_memory

Input:

```text
query
types
scope
tags
limit
```

Return active memories by default.

Clearly indicate superseded memory when explicitly requested.

---

# 54. MCP OUTPUT SAFETY

Every MCP method must implement:

```text
max result count
max snippet length
max traversal depth
max serialized response size
```

The tool must prefer:

```text
20 compact useful results
```

over:

```text
10 MB JSON dump
```

---

# 55. OPTIONAL MCP RESOURCES

After tools are stable, consider resources such as:

```text
codememory://repository/status

codememory://file/<path>

codememory://symbol/<id>
```

Do not prioritize resources over core tools.

---

# 56. STDIO CONFIGURATION DOCUMENTATION

Document setup examples generically.

Provide instructions for connecting:

```text
Codex
Claude Code
other MCP clients
```

Do not assume only one client.

---

# 57. GIT INTEGRATION

Create a Git adapter.

Initially support:

```text
repository root
current branch
HEAD commit
tracked files
ignored files
changed files
rename hints
```

Possible later features:

```text
symbol history
commit history
blame
recent changes
```

Do not block v0.1 on advanced Git intelligence.

---

# 58. MONOREPOS

The system must work inside monorepos.

Examples:

```text
apps/api
apps/web
packages/common
packages/database
```

One registered repository can contain several workspace projects.

Do not assume one tsconfig.

Track project context in symbol metadata when possible.

---

# 59. MULTIPLE REPOSITORIES

Architecture must allow:

```text
Repository A
Repository B
Repository C
```

inside the same database.

Every relevant database entity must be scoped by repository ID.

Never allow accidental cross-repository graph edges unless an explicit future workspace layer allows them.

---

# 60. FUTURE WORKSPACE MODEL

Do NOT fully implement unless naturally easy.

Design so future versions can have:

```text
Workspace
├── api
├── web
├── mobile
└── shared
```

allowing cross-repository queries.

But v0.1 can operate repository-by-repository.

---

# 61. PLUGIN SDK

Create a clear plugin interface.

Example concept:

```ts
interface LanguagePlugin {
  id: string;

  extensions: string[];

  canHandle(file: IndexedFile): boolean;

  createContext(
    repository: Repository
  ): Promise<LanguageContext>;

  analyzeFile(
    context: LanguageContext,
    file: IndexedFile
  ): Promise<FileAnalysisResult>;
}
```

FileAnalysisResult should contain:

```text
symbols
edges
unresolved references
diagnostics
```

---

# 62. FRAMEWORK PLUGIN API

Future framework plugins should be able to augment graph data.

Concept:

```ts
interface FrameworkPlugin {
  id: string;

  detect(
    repository: RepositoryContext
  ): Promise<boolean>;

  analyze(
    context: FrameworkAnalysisContext
  ): Promise<FrameworkAnalysisResult>;
}
```

Examples later:

```text
NestJS

Express

Elysia

Next.js

Prisma

Socket.IO
```

---

# 63. FUTURE FRAMEWORK GRAPH TYPES

Do not implement all now, but design edge extensibility for:

```text
HANDLES_ROUTE

USES_MODEL

READS_TABLE

WRITES_TABLE

EMITS_EVENT

LISTENS_EVENT

PRODUCES_QUEUE

CONSUMES_QUEUE

READS_ENV
```

Do not require database migrations every time a new edge type is added if it can safely be modeled as validated strings/enums.

---

# 64. ROUTE INTELLIGENCE — FUTURE

Eventually:

```text
POST /orders/:id/complete
→ controller
→ service
→ repository
→ database
```

should be traceable.

Do NOT fake this in v0.1.

Only add when framework plugins can reliably detect it.

---

# 65. SOCKET INTELLIGENCE — FUTURE

Eventually:

```text
emit("order.completed")
```

and:

```text
on("order.completed")
```

should produce event graph relationships.

Again:

Do not use text matching pretending to be semantic truth.

Framework-specific plugins should own this.

---

# 66. ERROR HANDLING

Use typed/domain errors.

Examples:

```text
RepositoryNotFoundError

ParserError

DatabaseError

AmbiguousSymbolError

SymbolNotFoundError

ConfigurationError

IndexingError
```

CLI should present clean user-friendly errors.

Debug mode can show stack traces.

---

# 67. LOGGING

Create structured logging.

Levels:

```text
error
warn
info
debug
trace
```

Never use random uncontrolled console.log statements throughout core code.

MCP STDIO transport MUST never write logs to stdout.

---

# 68. CORRELATION IDs

Index runs should have:

```text
runId
```

Logs/errors for that index run should reference it.

This will make debugging real-world indexing failures much easier.

---

# 69. INDEX RUN HISTORY

Store:

```text
start time
end time
repository
mode
files discovered
files changed
files indexed
files skipped
symbols created
edges created
warnings
errors
duration
status
```

Modes:

```text
FULL
INCREMENTAL
WATCH
```

---

# 70. FAILED FILE INDEXING

A parser failure in one source file should not necessarily abort the entire repository.

Record:

```text
INDEX_ERROR
```

for that file.

Continue where safe.

At completion report:

```text
1,930 indexed
2 failed
```

rather than losing all progress.

---

# 71. DATABASE TRANSACTIONS

Indexing a single file should be atomic.

Conceptually:

```text
BEGIN

remove old symbols for file
remove old file edges
insert new symbols
insert new edges
update search data
update file hash/status

COMMIT
```

On failure:

```text
ROLLBACK
```

---

# 72. IDENTITY AND REINDEXING

Do not produce duplicate symbols on every run.

Use deterministic or upsertable symbol identity.

Running:

```bash
codememory index .
```

twice with no source changes must be effectively idempotent.

Counts must remain stable.

---

# 73. PERFORMANCE TARGETS

Do not prematurely optimize, but design intelligently.

For development targets:

```text
1,000 files:
comfortable local indexing

10,000 source files:
must remain usable

100,000 symbols:
queries should remain responsive
```

No strict benchmark required initially, but build benchmark tooling.

---

# 74. BENCHMARK COMMAND

Eventually or during v0.1 if simple:

```bash
codememory benchmark
```

Measure:

```text
file discovery
hashing
AST parsing
relationship resolution
database writes
search latency
graph query latency
```

At least create a benchmark script.

---

# 75. SECURITY

Assume indexed repositories may contain sensitive source code.

Requirements:

```text
no telemetry by default

no external uploads by default

no external embedding provider by default

secret files excluded

clear documentation when cloud embedding is enabled
```

Do not send code anywhere unless explicitly configured.

---

# 76. PATH SECURITY

Normalize repository paths.

Prevent:

```text
../../etc/passwd
```

style traversal.

All file access through MCP must remain inside registered repository roots.

Symlinks must be handled carefully.

Never follow a symlink outside the registered repository root unless explicitly configured.

Default:

```text
deny
```

---

# 77. MCP MUTATION SAFETY

The MCP server's purpose is code intelligence.

It should NOT modify repository source files.

`remember` may modify CodeMemory's own database.

Code modification belongs to the coding agent itself.

This separation is intentional.

---

# 78. TESTING STRATEGY

Testing is a first-class requirement.

Use:

```text
unit tests
integration tests
end-to-end tests
parser fixtures
regression tests
```

---

# 79. TEST FIXTURES

Create:

```text
tests/fixtures/typescript/
```

Suggested:

```text
basic-functions

arrow-functions

classes

class-methods

interfaces

inheritance

implements

imports

exports

re-exports

aliases

default-exports

circular-imports

nested-functions

overloads

generics

tsconfig-paths

multiple-tsconfigs

monorepo

tsx

javascript

dynamic-import

optional-chaining

destructuring
```

Each fixture should be intentionally tiny.

Tests should make exact assertions.

---

# 80. REGRESSION TEST POLICY

Create documentation:

```text
docs/regression-policy.md
```

Rule:

Every real-world parser/indexer bug must eventually have:

```text
fixture
+
test
+
fix
```

Example:

Bug:

```text
async arrow functions are not indexed
```

Create:

```text
tests/fixtures/typescript/regression-001-async-arrow/
```

Then fix parser.

This policy is central to the project.

---

# 81. DATABASE INTEGRATION TESTS

Use an isolated test database.

Tests must clean up after themselves.

Do not depend on developer's production/local data.

Docker/Testcontainers may be used if reliable under Bun.

Otherwise provide dedicated test PostgreSQL configuration.

---

# 82. MCP E2E TEST

Create an E2E test that:

1. Creates temporary repository fixture.
2. Indexes it.
3. Starts MCP server.
4. Connects MCP client.
5. Calls search_symbols.
6. Calls find_callers.
7. Verifies structured result.
8. Stops server cleanly.

This is a mandatory acceptance test.

---

# 83. CLI E2E TEST

Test at least:

```text
init
index
status
search
doctor
```

against a fixture repository.

---

# 84. LINTING / FORMATTING

Use a consistent formatter and linter.

Do not create an overly complex lint configuration.

Enable strong rules for:

```text
unused variables
unsafe any where practical
floating promises
unhandled async operations
```

Avoid excessive stylistic bikeshedding.

---

# 85. TYPESCRIPT REQUIREMENTS

Enable strict TypeScript.

Avoid:

```ts
any
```

unless absolutely necessary at external boundaries.

Prefer:

```ts
unknown
```

and validation.

No silent type errors.

Production build must pass:

```bash
bun run typecheck
```

---

# 86. CI

Create GitHub Actions CI.

On pull request:

```text
install
lint
typecheck
unit tests
integration tests
build
```

If integration DB is required, start PostgreSQL + pgvector service.

---

# 87. REQUIRED PACKAGE SCRIPTS

Root package should support:

```bash
bun install

bun run build

bun run dev

bun run lint

bun run typecheck

bun run test

bun run test:unit

bun run test:integration

bun run test:e2e
```

Keep commands predictable.

---

# 88. DEVELOPMENT ENVIRONMENT

Make development simple.

Target experience:

```bash
git clone ...

cd codebase-memory

bun install

docker compose up -d

bun run db:migrate

bun run dev
```

Then in another repository:

```bash
codememory init

codememory index .

codememory status

codememory mcp
```

---

# 89. DATABASE MIGRATIONS

Provide commands:

```bash
bun run db:migrate

bun run db:status

bun run db:rollback
```

Rollback is optional if migration framework does not safely support it.

Forward-only migrations are acceptable if documented.

---

# 90. GRACEFUL SHUTDOWN

Handle:

```text
SIGINT
SIGTERM
```

Cleanly stop:

```text
file watcher
database pool
worker queue
MCP transport
```

No corrupted indexing state.

---

# 91. LOCKING

Prevent two full index jobs from accidentally operating on the same repository simultaneously.

Implement repository-level indexing lock.

A watcher and manual index should coordinate.

Stale locks need diagnostics.

---

# 92. INDEX VERSIONING

Store index schema/parser version.

When parser behavior changes significantly, we may need to re-index.

Support detecting:

```text
stored parser version != current parser version
```

and recommend:

```text
codememory index --force
```

---

# 93. DEBUGGING COMMANDS

Useful internal commands may include:

```bash
codememory debug symbol <id>

codememory debug file <path>

codememory debug edges <symbol>

codememory debug unresolved

codememory debug config
```

These will be extremely valuable while fixing real-world edge cases.

Do not expose them prominently if they clutter normal CLI.

---

# 94. UNRESOLVED REPORT

Add:

```bash
codememory debug unresolved
```

Output most frequent unresolved patterns.

Example:

```text
312 dynamic property calls
110 aliased imports
43 decorator references
```

This helps prioritize future parser improvements.

---

# 95. README

README must clearly explain:

```text
what this is
what this is not

installation

requirements

quick start

how indexing works

MCP setup

privacy

CLI commands

current language support

known limitations

development
```

Be honest about limitations.

Never claim unsupported features.

---

# 96. DOCUMENTATION

Create:

```text
docs/architecture.md

docs/indexing.md

docs/graph.md

docs/memory.md

docs/mcp.md

docs/plugins.md

docs/regression-policy.md

docs/troubleshooting.md

docs/development.md
```

Architecture document should include Mermaid diagrams.

---

# 97. ARCHITECTURE DIAGRAM

Architecture approximately:

```text
                MCP CLIENTS
        ┌────────────────────────┐
        │ Codex / Claude / etc. │
        └────────────┬───────────┘
                     │
                    MCP
                     │
        ┌────────────▼───────────┐
        │      MCP SERVER        │
        └────────────┬───────────┘
                     │
    ┌────────────────┼────────────────┐
    │                │                │
    ▼                ▼                ▼
 Search Service   Graph Service    Memory Service
    │                │                │
    └────────────────┼────────────────┘
                     │
                 Core Domain
                     │
               Storage Layer
                     │
                PostgreSQL
                     ▲
                     │
               Indexing Engine
                     ▲
                     │
              Language Plugins
                     ▲
                     │
                Repository
```

Turn this into Mermaid documentation.

---

# 98. V0.1 SCOPE

V0.1 must focus on reliability.

Required:

```text
Bun monorepo

PostgreSQL

migrations

repository registration

file discovery

gitignore support

file hashing

incremental indexing

TypeScript/JavaScript/TSX parser

symbol extraction

import graph

basic reference graph

function/method caller relationships

class inheritance

interface implementations

symbol search

lexical code search

persistent explicit memory

CLI

MCP stdio server

watch mode

doctor

unit tests

integration tests

MCP E2E test

documentation
```

---

# 99. EXPLICITLY OUT OF V0.1

Do NOT spend implementation time building:

```text
web dashboard

Neo4j

AI-generated summaries

automatic memory creation

Python support

C# support

Go support

route framework detection

Prisma intelligence

Socket.IO intelligence

queue intelligence

cloud SaaS

authentication system

billing

multi-user collaboration
```

Only create extension points for these.

---

# 100. V0.2 ROADMAP

After real-world usage:

```text
Prisma plugin

Express plugin

Elysia plugin

NestJS plugin

route graph

better call resolution

git history

memory superseding UX

OpenAI-compatible embeddings

Ollama embeddings

hybrid semantic search
```

Do not implement unless v0.1 is stable.

---

# 101. V0.3 ROADMAP

Potential:

```text
Socket.IO graph

event emit/listener graph

cron detection

queue detection

environment variable references

database read/write graph

workspace/multi-repo relationships
```

---

# 102. V0.4 ROADMAP

Possible:

```text
Python LanguagePlugin

C# LanguagePlugin

Go LanguagePlugin

Tree-sitter general parser layer
```

---

# 103. V0.5 ROADMAP

Only after core proves useful:

```text
web UI

dependency visualization

graph explorer

index diagnostics UI

memory browser

repository dashboard
```

---

# 104. ACCEPTANCE SCENARIO

Create fixture:

```text
src/
  order.controller.ts
  order.service.ts
  stock.service.ts
  repository.ts
```

Example relationship:

```text
OrderController.complete
→ OrderService.completeOrder
→ StockService.deduct
→ StockRepository.createMovement
```

After indexing:

```bash
codememory symbol completeOrder
```

must find:

```text
OrderService.completeOrder
```

Then:

```bash
codememory callers OrderService.completeOrder
```

must return:

```text
OrderController.complete
```

Then MCP:

```text
find_callees(OrderService.completeOrder)
```

must return:

```text
StockService.deduct
```

Then graph traversal should produce:

```text
OrderController.complete
→ OrderService.completeOrder
→ StockService.deduct
→ StockRepository.createMovement
```

without an LLM having to inspect all source files.

---

# 105. AMBIGUITY TEST

Fixture contains:

```text
OrderService.complete
PaymentService.complete
```

If MCP receives:

```text
find_callers("complete")
```

it MUST NOT arbitrarily choose one.

Return:

```text
AMBIGUOUS_SYMBOL
```

with candidates.

This behavior is mandatory.

---

# 106. IDEMPOTENCY TEST

Run:

```bash
codememory index .
```

Record counts.

Run again without changing source.

The following should remain stable:

```text
files
symbols
edges
memories
```

No duplicate records.

---

# 107. INCREMENTAL TEST

Index repository.

Change one source file.

Run index again.

Assert:

```text
unchanged file hashes untouched

changed file reprocessed

removed edges cleaned

new edges created
```

Collect instrumentation proving that unrelated source files were not reparsed unnecessarily.

---

# 108. DELETE TEST

Index repository.

Delete one file.

Index.

Assert:

```text
file removed/marked deleted

symbols gone

dangling edges gone

search results gone
```

---

# 109. MEMORY TEST

Create:

```text
DECISION:
Do not access the database directly from controllers.
```

Then:

```text
search_memory("controllers database")
```

must retrieve it.

Code reindexing MUST NOT delete memories.

---

# 110. MCP RESPONSE QUALITY

Each response should be optimized for AI consumption.

Prefer compact structured data.

Example good:

```text
symbol
location
signature
callers
confidence
```

Avoid huge nested payloads.

Do not repeat redundant information.

---

# 111. OBSERVABILITY

Track internal timings when debug is enabled.

Example:

```text
scan: 43ms

hash: 87ms

parse: 821ms

resolve: 230ms

persist: 140ms

search-index: 52ms
```

These metrics will help when scaling.

---

# 112. DATA CLEANUP

Command:

```bash
codememory clean
```

should show what will be removed.

Support:

```text
--stale
--repository
--all
```

Require confirmation before destructive `--all` unless:

```text
--yes
```

is provided.

---

# 113. VERSION COMMAND

Implement:

```bash
codememory --version
```

Include versions in diagnostics:

```text
CodeMemory
Bun
TypeScript parser
database schema
MCP SDK
```

---

# 114. NAMING

For now use internal project/product name:

```text
CodeMemory
```

CLI:

```text
codememory
```

Do not deeply hard-code branding.

Keep package metadata easy to rename later.

---

# 115. CODE QUALITY EXPECTATIONS

Do not create:

```text
god classes

5,000-line modules

circular package dependencies

business logic inside CLI commands

database SQL inside MCP tool handlers

parser implementation inside MCP layer
```

Expected flow:

```text
CLI
↓
Application Service
↓
Domain/Interfaces
↓
Infrastructure
```

and:

```text
MCP Tool
↓
Application Service
↓
Domain/Interfaces
↓
Infrastructure
```

CLI and MCP are adapters.

---

# 116. DEPENDENCY RULES

Conceptually:

```text
core
↑
services
↑
adapters
```

Core should not import:

```text
mcp
cli
postgres
```

MCP should not implement graph logic itself.

CLI should not implement indexing logic itself.

---

# 117. NO PREMATURE ABSTRACTION

Architecture should be clean but pragmatic.

Do not build an enterprise framework just because a future feature might need it.

A useful rule:

> Abstract boundaries where we already know multiple implementations are likely.

Examples worth abstracting now:

```text
LanguagePlugin

EmbeddingProvider

Storage repositories

GitProvider
```

Examples not worth creating enormous abstractions for:

```text
every utility function
every SQL query
every AST visitor
```

---

# 118. IMPLEMENTATION PHASES

Implement in this order.

## Phase 0 — Repository setup

Create:

```text
workspace

TypeScript config

lint

format

test environment

CI

Docker PostgreSQL

migration system

logging
```

Make sure:

```bash
bun run build
bun run typecheck
bun run test
```

work before moving on.

---

## Phase 1 — Database/domain

Implement:

```text
repository model
file model
symbol model
edge model
memory model

database migrations
repository stores
```

Add integration tests.

---

## Phase 2 — Repository scanner

Implement:

```text
root detection
.gitignore
default exclusions
secret exclusions
binary detection
hashing
```

Test heavily.

---

## Phase 3 — TypeScript parser

Implement:

```text
program creation
tsconfig loading
AST traversal
symbol extraction
qualified names
imports
exports
class relationships
basic references
basic calls
```

Build fixtures as each feature lands.

---

## Phase 4 — Index pipeline

Implement:

```text
full index
incremental index
delete handling
file atomic transactions
index run records
errors
```

---

## Phase 5 — Search

Implement:

```text
exact symbols
prefix
fuzzy
lexical
ranking
```

Semantic embedding remains optional.

---

## Phase 6 — Memory

Implement:

```text
create
search
archive
supersede groundwork
```

---

## Phase 7 — CLI

Implement:

```text
init
index
status
search
symbol
callers
callees
references
remember
memories
doctor
watch
```

---

## Phase 8 — MCP

Implement official MCP v2 STDIO server.

Expose required tools.

Add E2E MCP test.

---

## Phase 9 — Hardening

Run against larger fixture repositories.

Check:

```text
memory usage
query latency
incremental behavior
cycles
ambiguous symbols
large files
broken TS projects
missing tsconfig
```

---

## Phase 10 — Documentation/release

Finish:

```text
README
architecture docs
MCP setup docs
troubleshooting
known limitations
changelog
```

Tag:

```text
v0.1.0
```

only after acceptance criteria pass.

---

# 119. DEVELOPMENT WORKFLOW FOR BUGS

Once the first usable version exists, future work must follow:

```text
real project
↓
bug discovered
↓
minimal reproduction
↓
fixture created
↓
test fails
↓
implementation fixed
↓
test passes
↓
full suite passes
↓
release
```

Never patch real-world edge cases only with ad-hoc conditions.

Try to identify the general AST/parser problem.

---

# 120. BUG REPORT TEMPLATE

Create GitHub issue template containing:

```text
CodeMemory version

Bun version

OS

repository language

minimal code sample

expected result

actual result

codememory doctor output

reproduction steps
```

Never require users to upload proprietary repository contents.

---

# 121. CHANGELOG

Maintain:

```text
CHANGELOG.md
```

Sections:

```text
Added
Changed
Fixed
Removed
Known Issues
```

Parser fixes should mention what construct was corrected.

---

# 122. FIRST RELEASE DEFINITION OF DONE

v0.1.0 is complete only if all of these are true:

```text
fresh clone works

bun install works

database can be started

migrations work

codememory init works

codememory index works

TS/JS/TSX symbols are extracted

imports are resolved

basic function callers/callees work

incremental indexing works

deletions are handled

watch mode works

symbol search works

code search works

memories persist

doctor works

MCP starts over stdio

Codex/another MCP client can call tools

MCP E2E test passes

CI passes

documentation exists
```

---

# 123. IMPORTANT IMPLEMENTATION BEHAVIOR

You are authorized to make reasonable engineering decisions without asking for approval for every small implementation detail.

Do not stop because of minor ambiguities.

Choose the simplest clean solution consistent with this specification.

However:

Do NOT silently remove requirements.

If something cannot reasonably be completed, document:

```text
what is incomplete
why
current implementation
recommended next action
```

---

# 124. DO NOT FAKE FUNCTIONALITY

Never create placeholder functions that pretend functionality exists.

Bad:

```ts
async findCallers() {
  return [];
}
```

while claiming callers are supported.

If unfinished:

```text
mark it explicitly unfinished
```

or do not expose the MCP tool yet.

---

# 125. VERIFY EVERYTHING

Before declaring a phase complete:

Run:

```bash
bun run lint
bun run typecheck
bun run test
bun run build
```

where relevant.

At final completion also run E2E tests.

Do not claim success solely because code compiles.

---

# 126. KEEP A DEVELOPMENT TRACKER

Create:

```text
docs/implementation-status.md
```

Track:

```text
DONE

IN PROGRESS

NOT STARTED

BLOCKED
```

for major requirements.

Update this document while developing.

This allows development to continue across multiple Codex sessions.

---

# 127. KEEP AN ENGINEERING DECISION LOG

Create:

```text
docs/decisions/
```

Use small ADR files.

Example:

```text
0001-postgresql-storage.md

0002-typescript-compiler-api.md

0003-mcp-stdio-first.md
```

Each ADR:

```text
Context

Decision

Alternatives

Consequences
```

Do not write ADRs for trivial choices.

---

# 128. FINAL DELIVERY REPORT

When implementation is complete, return a concise engineering report containing:

```text
What was implemented

Repository structure

How to install

How to start database

How to migrate

How to index a repository

How to start MCP

How to connect an MCP client

Test results

Known limitations

Next recommended milestone
```

Also include actual commands.

---

# 129. STARTING INSTRUCTIONS

Begin now.

First:

1. Inspect the current directory.
2. Determine whether this is an empty repository or existing project.
3. If empty, initialize the structure described here.
4. Create `docs/implementation-status.md`.
5. Create the foundation.
6. Work phase by phase.
7. Continuously run tests.
8. Do not wait for additional approval between ordinary implementation steps.
9. Do not implement out-of-scope v0.2 features prematurely.
10. Keep the repository runnable throughout development.

The highest priority is:

> A small, reliable, testable code intelligence engine that we can immediately use on real TypeScript/JavaScript repositories and then improve through real-world regression cases.

The project succeeds when an MCP coding agent can reliably ask CodeMemory where code is, how symbols relate to one another, and what persistent project decisions it should know—without re-reading an entire repository every time.

import { relative } from "node:path";
import type { ProjectContext, ProjectStore } from "@codememory/core";
import type { ProjectSession } from "@codememory/indexer";
import { MemoryService, memorySearchSchema } from "@codememory/memory";
import { safePath, slash } from "@codememory/shared";
import { z } from "zod";

const paging = {
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(100000).default(0),
};
const symbol = { symbolId: z.string().max(100).optional(), name: z.string().max(500).optional() };
export const schemas = {
  codebase_status: z.object({}).strict(),
  search_symbols: z
    .object({
      query: z.string().min(1).max(500),
      kinds: z.array(z.string().max(30)).max(20).default([]),
      ...paging,
    })
    .strict(),
  search_code: z.object({ query: z.string().min(1).max(500), ...paging }).strict(),
  get_symbol: z.object(symbol).strict(),
  get_file_outline: z.object({ path: z.string().max(1000), ...paging }).strict(),
  get_file_context: z
    .object({
      path: z.string().max(1000),
      line: z.number().int().min(1).max(2147483597),
      before: z.number().int().min(0).max(50).default(5),
      after: z.number().int().min(0).max(50).default(10),
    })
    .strict(),
  find_references: z.object({ ...symbol, ...paging }).strict(),
  find_callers: z.object({ ...symbol, ...paging }).strict(),
  find_callees: z.object({ ...symbol, ...paging }).strict(),
  trace_dependencies: z
    .object({
      fromSymbolId: z.string().max(100),
      direction: z.enum(["incoming", "outgoing"]).default("outgoing"),
      maxDepth: z.number().int().min(1).max(10).default(3),
      maxPaths: z.number().int().min(1).max(100).default(20),
      edgeTypes: z.array(z.string().max(40)).max(20).default([]),
    })
    .strict(),
  search_memory: memorySearchSchema,
};
/** Shared application facade. Adapter schemas cannot supply repository IDs. */
export class CodebaseService {
  readonly memory: MemoryService;
  constructor(
    readonly context: ProjectContext,
    private readonly store: ProjectStore,
    private readonly session?: ProjectSession,
  ) {
    this.memory = new MemoryService(context, store);
  }
  async status() {
    return this.session
      ? this.session.status()
      : {
          projectRoot: this.context.canonicalRoot,
          projectScopeId: this.context.projectScopeId,
          projectSource: "explicit --project",
          autoIndex: false,
          watcher: false,
          ...(await this.store.status(this.context)),
        };
  }
  async execute(name: keyof typeof schemas, input: unknown): Promise<Record<string, unknown>> {
    if (name === "codebase_status") {
      schemas.codebase_status.parse(input);
      return this.status();
    }
    if (name === "search_memory") {
      const p = schemas.search_memory.parse(input);
      return this.memory.searchFiltered(p);
    }
    // Validate before opening a database transaction; resolve filesystem boundaries outside it.
    const p = schemas[name].parse(input);
    let path: string | undefined;
    if ("path" in p) {
      const actual = await safePath(this.context, p.path);
      path = slash(relative(this.context.canonicalRoot, actual));
    }
    const pendingChanges = this.session ? (await this.session.status()).pendingChanges : 0;
    return this.store.readIndex(this.context, async (reader, metadata) => {
      let data: Record<string, unknown>;
      switch (name) {
        case "search_symbols": {
          const p = schemas[name].parse(input);
          data = await reader.searchSymbols(p.query, p.kinds, p);
          break;
        }
        case "search_code": {
          const p = schemas[name].parse(input);
          data = await reader.searchCode(p.query, p);
          break;
        }
        case "get_symbol":
          data = await reader.symbol(schemas[name].parse(input));
          break;
        case "find_references":
        case "find_callers":
        case "find_callees": {
          const p = schemas[name].parse(input);
          data = await reader.relationships(
            p,
            name === "find_callees" ? "outgoing" : "incoming",
            name === "find_references" ? "REFERENCES" : "CALLS",
            p,
          );
          break;
        }
        case "trace_dependencies": {
          const p = schemas[name].parse(input);
          data = await reader.trace(
            p.fromSymbolId,
            p.direction,
            p.maxDepth,
            p.maxPaths,
            p.edgeTypes,
          );
          break;
        }
        case "get_file_outline":
          data = await reader.outline(path as string, schemas[name].parse(input));
          break;
        case "get_file_context": {
          const p = schemas[name].parse(input);
          data = await reader.context(path as string, p.line, p.before, p.after);
          break;
        }
      }
      return { ...metadata, pendingChanges, ...data };
    });
  }
}

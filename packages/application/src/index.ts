import { relative } from "node:path";
import { CodeMemoryError, type ProjectContext, type ProjectStore } from "@codememory/core";
import { relationships, resolveSymbol, trace } from "@codememory/graph";
import type { ProjectSession } from "@codememory/indexer";
import { MemoryService } from "@codememory/memory";
import { searchCode, searchSymbols } from "@codememory/search";
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
      line: z.number().int().min(1),
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
  search_memory: z
    .object({
      query: z.string().max(500).default(""),
      includeInactive: z.boolean().default(false),
      ...paging,
    })
    .strict(),
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
      return this.memory.search(p.query, p.limit, p.offset, p.includeInactive);
    }
    const snapshot = await this.store.snapshot(this.context);
    if (!snapshot.version)
      throw new CodeMemoryError("INDEX_NOT_READY", "Selected project has no completed index");
    const metadata = {
      indexVersion: snapshot.version,
      indexedAt: snapshot.indexedAt,
      freshness: "LAST_COMPLETED",
      incomplete:
        snapshot.diagnostics.length > 0 || snapshot.files.some((f) => f.status !== "INDEXED"),
      pendingChanges: this.session ? (await this.session.status()).pendingChanges : 0,
    };
    let data: Record<string, unknown>;
    switch (name) {
      case "search_symbols": {
        const p = schemas[name].parse(input);
        data = searchSymbols(snapshot, p.query, p.limit, p.offset, p.kinds);
        break;
      }
      case "search_code": {
        const p = schemas[name].parse(input);
        data = searchCode(snapshot, p.query, p.limit, p.offset);
        break;
      }
      case "get_symbol": {
        const p = schemas[name].parse(input),
          s = resolveSymbol(snapshot, p.symbolId, p.name);
        const file = snapshot.files.find((f) => f.id === s.fileId);
        data = {
          symbol: s,
          snippet: file?.content
            .split(/\r?\n/)
            .slice(s.startLine - 1, Math.min(s.endLine, s.startLine + 15))
            .join("\n")
            .slice(0, 4000),
          incoming: snapshot.edges.filter((e) => e.target === s.id).length,
          outgoing: snapshot.edges.filter((e) => e.source === s.id).length,
        };
        break;
      }
      case "find_references":
      case "find_callers":
      case "find_callees": {
        const p = schemas[name].parse(input),
          s = resolveSymbol(snapshot, p.symbolId, p.name);
        data = relationships(
          snapshot,
          s.id,
          name === "find_callees" ? "outgoing" : "incoming",
          name === "find_references" ? "REFERENCES" : "CALLS",
          p.limit,
          p.offset,
        );
        break;
      }
      case "trace_dependencies": {
        const p = schemas[name].parse(input);
        data = trace(snapshot, p.fromSymbolId, p.direction, p.maxDepth, p.maxPaths, p.edgeTypes);
        break;
      }
      case "get_file_outline":
      case "get_file_context": {
        const p = schemas[name].parse(input);
        const actual = await safePath(this.context, p.path);
        const path = slash(relative(this.context.canonicalRoot, actual));
        const file = snapshot.files.find((f) => f.path === path && f.status === "INDEXED");
        if (!file) throw new CodeMemoryError("NOT_FOUND", "File not present in selected index");
        if (name === "get_file_outline") {
          const paging = schemas.get_file_outline.parse(input);
          const all = snapshot.symbols.filter((s) => s.fileId === file.id);
          data = {
            results: all.slice(paging.offset, paging.offset + paging.limit),
            hasMore: all.length > paging.offset + paging.limit,
          };
        } else {
          const range = schemas.get_file_context.parse(input);
          const lines = file.content.split(/\r?\n/);
          const start = Math.max(0, range.line - 1 - range.before),
            end = Math.min(lines.length, range.line + range.after);
          data = {
            path,
            startLine: start + 1,
            endLine: end,
            content: lines.slice(start, end).join("\n").slice(0, 12000),
            source: "indexed snapshot",
          };
        }
        break;
      }
      default:
        throw new CodeMemoryError("UNKNOWN_TOOL", "Unknown tool");
    }
    return { ...metadata, ...data };
  }
}

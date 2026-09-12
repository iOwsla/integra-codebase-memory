import { relative } from "node:path";
import type { ProjectContext, ProjectStore } from "@codememory/core";
import type { ProjectSession } from "@codememory/indexer";
import {
  MemoryService,
  MemoryWorkflowService,
  memorySearchSchema,
  workflowReadSchemas,
} from "@codememory/memory";
import { runtimeInfo, safePath, slash } from "@codememory/shared";
import { z } from "zod";

const paging = {
  limit: z.number().int().min(1).max(100).default(20),
  offset: z.number().int().min(0).max(100000).default(0),
};
const symbol = { symbolId: z.string().max(100).optional(), name: z.string().max(500).optional() };
export const schemas = {
  codebase_status: z
    .object({
      diagnosticLimit: z
        .number()
        .int()
        .min(1)
        .default(10)
        .describe(
          "Diagnostic messages per page; default 10, maximum returned 20. Larger requests are reduced to 20. Follow diagnosticSummary.nextOffset.",
        ),
      diagnosticOffset: z.number().int().min(0).max(100000).default(0),
    })
    .strict(),
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
  find_dead_code_candidates: z.object(paging).strict(),
  find_duplicate_code: z
    .object({ ...paging, minBodyLength: z.number().int().min(20).max(100000).default(80) })
    .strict(),
  search_memory: memorySearchSchema,
  ...workflowReadSchemas,
};
/** Shared application facade. Adapter schemas cannot supply repository IDs. */
export class CodebaseService {
  readonly memory: MemoryService;
  readonly memoryWorkflow: MemoryWorkflowService;
  constructor(
    readonly context: ProjectContext,
    private readonly store: ProjectStore,
    private readonly session?: ProjectSession,
  ) {
    this.memory = new MemoryService(context, store);
    this.memoryWorkflow = new MemoryWorkflowService(context, store);
  }
  async status(input: unknown = {}): Promise<Record<string, unknown>> {
    const options = schemas.codebase_status.parse(input);
    const requestedLimit = options.diagnosticLimit;
    options.diagnosticLimit = Math.min(requestedLimit, 20);
    const status: Record<string, unknown> = this.session
      ? await this.session.status(options)
      : {
          projectRoot: this.context.canonicalRoot,
          projectScopeId: this.context.projectScopeId,
          projectSource: "explicit --project",
          autoIndex: false,
          watcher: false,
          ...(await this.store.status(this.context, options)),
        };
    return {
      ...status,
      ...(requestedLimit > options.diagnosticLimit
        ? {
            diagnosticSummary: {
              ...(status.diagnosticSummary as Record<string, unknown>),
              requestedLimit,
              limitReduced: true,
            },
          }
        : {}),
      runtime: { ...runtimeInfo(), sessionId: this.context.sessionId },
      analysisScope: {
        languages: ["JavaScript", "TypeScript", "Prisma"],
        extensions: [".js", ".jsx", ".mjs", ".cjs", ".ts", ".tsx", ".mts", ".cts", ".prisma"],
        unsupportedExamples: ["Kotlin"],
        include: this.context.effectiveConfig.include,
        exclude: this.context.effectiveConfig.exclude,
        excludeGenerated: this.context.effectiveConfig.excludeGenerated,
        maxFileSizeBytes: this.context.effectiveConfig.maxFileSizeBytes,
        limitations:
          "Static in-scope sources only. Indexed files do not imply resolved dynamic references. Check unresolvedReferences, exclusions and source before dead-code claims.",
      },
    };
  }
  async execute(name: keyof typeof schemas, input: unknown): Promise<Record<string, unknown>> {
    if (name === "codebase_status") {
      return this.status(input);
    }
    if (name === "get_memory_checkpoints") return this.memoryWorkflow.checkpoints.list(input);
    if (name === "recall_context") return this.memoryWorkflow.recall(input);
    if (name === "memory_workflow_status") return this.memoryWorkflow.status();
    if (name === "list_memory_candidates") return this.memoryWorkflow.list(input);
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
    const sessionStatus = this.session ? await this.session.status() : undefined;
    const pendingChanges = sessionStatus?.pendingChanges ?? 0;
    const updating = sessionStatus?.freshness === "UPDATING";
    return this.store.readIndex(this.context, async (reader, metadata) => {
      let data: Record<string, unknown>;
      switch (name) {
        case "find_dead_code_candidates":
          data = await reader.deadCodeCandidates(schemas[name].parse(input));
          break;
        case "find_duplicate_code": {
          const p = schemas[name].parse(input);
          data = await reader.duplicateCode(p.minBodyLength, p);
          break;
        }
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
      return {
        ...metadata,
        pendingChanges,
        ...data,
        servedFromVersion: metadata.indexVersion,
        ...(updating
          ? { incomplete: true, freshness: "UPDATING", staleSince: sessionStatus?.staleSince }
          : {}),
      };
    });
  }
}

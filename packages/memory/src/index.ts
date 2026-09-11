import { randomUUID } from "node:crypto";
import { lstat, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import type { MemoryEntry, ProjectContext, ProjectStore } from "@codememory/core";
import { CodeMemoryError } from "@codememory/core";
import { contains, forbidden, safePath, slash } from "@codememory/shared";
import { z } from "zod";

const memoryType = z.enum([
  "FACT",
  "DECISION",
  "WARNING",
  "NOTE",
  "CONVENTION",
  "INCIDENT",
  "TODO",
]);
const scopeSchema = z
  .object({
    type: z.enum(["repository", "directory", "file", "symbol"]),
    target: z.string().min(1).max(1000).optional(),
  })
  .strict();
export const memorySearchSchema = z
  .object({
    query: z.string().max(500).default(""),
    types: z.array(memoryType).max(7).default([]),
    tags: z.array(z.string().min(1).max(50)).max(20).default([]),
    scope: scopeSchema.optional(),
    includeInactive: z.boolean().default(false),
    limit: z.number().int().min(1).max(100).default(20),
    offset: z.number().int().min(0).max(100000).default(0),
  })
  .strict();
export const memorySchema = z
  .object({
    type: memoryType,
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(10000),
    scope: scopeSchema.default({ type: "repository" }),
    tags: z.array(z.string().max(50)).max(20).default([]),
    priority: z.number().int().min(0).max(10).default(0),
    source: z.string().max(200).default("explicit user instruction"),
    supersedes: z.string().max(100).optional(),
  })
  .strict();
export class MemoryService {
  constructor(
    private readonly context: ProjectContext,
    private readonly store: ProjectStore,
  ) {}
  async remember(input: unknown) {
    const parsed = memorySchema.parse(input);
    const { supersedes, ...data } = parsed;
    if (data.scope.type === "repository" && data.scope.target !== undefined)
      throw new CodeMemoryError("INVALID_SCOPE", "Repository scope does not accept a target");
    if (data.scope.type !== "repository") {
      if (!data.scope.target)
        throw new CodeMemoryError("INVALID_SCOPE", "Memory scope requires a target");
      if (data.scope.type !== "symbol") {
        const actual = await safePath(this.context, data.scope.target);
        const info = await stat(actual);
        if (
          info.isDirectory() &&
          actual !== this.context.canonicalRoot &&
          (await lstat(resolve(actual, ".git")).then(
            () => true,
            () => false,
          ))
        )
          throw new CodeMemoryError("PATH_OUT_OF_SCOPE", "Nested repositories are excluded");
        if (data.scope.type === "file" ? !info.isFile() : !info.isDirectory())
          throw new CodeMemoryError("INVALID_SCOPE", "Target does not match the memory scope type");
        data.scope.target = slash(relative(this.context.canonicalRoot, actual)) || ".";
      }
      // Symbol existence is validated atomically by saveMemory; no full snapshot read.
    }
    const now = new Date().toISOString();
    const memory: MemoryEntry = {
      ...data,
      id: randomUUID(),
      status: "ACTIVE",
      createdAt: now,
      updatedAt: now,
    };
    await this.store.saveMemory(this.context, memory, supersedes);
    return memory;
  }
  async search(query: string, limit = 20, offset = 0, includeInactive = false) {
    return this.searchFiltered({ query, limit, offset, includeInactive });
  }
  async searchFiltered(input: unknown) {
    const p = memorySearchSchema.parse(input);
    let scopeTargets: string[] | undefined;
    if (p.scope?.type === "repository" && p.scope.target !== undefined)
      throw new CodeMemoryError("INVALID_SCOPE", "Repository scope does not accept a target");
    if (p.scope?.target && (p.scope.type === "file" || p.scope.type === "directory")) {
      // Lexical checks keep historical memories searchable after deletion; no source read.
      const actual = resolve(this.context.canonicalRoot, p.scope.target);
      const target = slash(relative(this.context.canonicalRoot, actual)) || ".";
      if (!contains(this.context.canonicalRoot, actual) || forbidden(target))
        throw new CodeMemoryError(
          "PATH_OUT_OF_SCOPE",
          "Memory filter is outside the selected project",
        );
      scopeTargets = [...new Set([target, actual, p.scope.target, `./${target}`])];
      p.scope.target = target;
    }
    return this.store.searchMemories(this.context, { ...p, scopeTargets });
  }
  async archive(id: string) {
    if (!(await this.store.archiveMemory(this.context, id)))
      throw new CodeMemoryError("NOT_FOUND", "Memory not found in selected project");
    return { archived: true };
  }
}

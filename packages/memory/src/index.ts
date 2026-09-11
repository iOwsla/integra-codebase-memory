import { randomUUID } from "node:crypto";
import type { MemoryEntry, ProjectContext, ProjectStore } from "@codememory/core";
import { CodeMemoryError } from "@codememory/core";
import { safePath } from "@codememory/shared";
import { z } from "zod";
export const memorySchema = z
  .object({
    type: z.enum(["FACT", "DECISION", "WARNING", "NOTE", "CONVENTION", "INCIDENT", "TODO"]),
    title: z.string().min(1).max(200),
    content: z.string().min(1).max(10000),
    scope: z
      .object({
        type: z.enum(["repository", "directory", "file", "symbol"]),
        target: z.string().max(1000).optional(),
      })
      .strict()
      .default({ type: "repository" }),
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
    if (data.scope.type !== "repository") {
      if (!data.scope.target)
        throw new CodeMemoryError("INVALID_SCOPE", "Memory scope requires a target");
      if (data.scope.type === "symbol") {
        if (
          !(await this.store.snapshot(this.context)).symbols.some((s) => s.id === data.scope.target)
        )
          throw new CodeMemoryError("NOT_FOUND", "Symbol not found in selected project");
      } else await safePath(this.context, data.scope.target);
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
    const q = query.toLowerCase();
    const rows = (await this.store.memories(this.context)).filter(
      (m) =>
        (includeInactive || m.status === "ACTIVE") &&
        `${m.title} ${m.content} ${m.tags.join(" ")}`.toLowerCase().includes(q),
    );
    return { results: rows.slice(offset, offset + limit), hasMore: rows.length > offset + limit };
  }
  async archive(id: string) {
    if (!(await this.store.archiveMemory(this.context, id)))
      throw new CodeMemoryError("NOT_FOUND", "Memory not found in selected project");
    return { archived: true };
  }
}

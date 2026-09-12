import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { isAbsolute, relative } from "node:path";
import {
  CodeMemoryError,
  type MemoryCheckpoint,
  type ProjectContext,
  type ProjectStore,
} from "@codememory/core";
import { hash, safePath, slash } from "@codememory/shared";
import { z } from "zod";

const memoryId = z.string().min(1).max(100);
export const checkpointSchema = z
  .object({
    memoryId,
    implementation: z.enum(["REQUESTED", "REPORTED_IMPLEMENTED"]),
    note: z.string().min(1).max(1000),
    links: z
      .array(
        z
          .object({
            path: z.string().min(1).max(1000),
            role: z.enum(["IMPLEMENTATION", "CALLER", "PRISMA_MODEL", "TEST"]),
            locator: z.string().min(1).max(300).optional(),
          })
          .strict(),
      )
      .max(10),
    verification: z.enum(["NOT_RUN", "REPORTED_PASS", "REPORTED_FAIL"]).default("NOT_RUN"),
    verificationNote: z.string().max(1000).default(""),
  })
  .strict()
  .superRefine((p, ctx) => {
    if (
      p.implementation === "REPORTED_IMPLEMENTED" &&
      !p.links.some((l) => l.role === "IMPLEMENTATION")
    )
      ctx.addIssue({
        code: "custom",
        message: "Reported implementation requires an implementation link",
      });
    if (
      p.verification !== "NOT_RUN" &&
      (!p.links.some((l) => l.role === "TEST") || !p.verificationNote.trim())
    )
      ctx.addIssue({
        code: "custom",
        message: "Reported test results require a test link and verification note",
      });
  });
export const checkpointReadSchema = z
  .object({
    memoryId,
    limit: z.number().int().min(1).max(5).default(1),
    offset: z.number().int().min(0).max(100000).default(0),
  })
  .strict();

/** Shared per-request I/O budget, including recall of multiple memories. */
export const checkpointBudget = () => ({ bytes: 8 * 1024 * 1024 });
export class MemoryCheckpointService {
  constructor(
    private readonly context: ProjectContext,
    private readonly store: ProjectStore,
  ) {}
  private async fingerprint(path: string, budget: { bytes: number }) {
    if (isAbsolute(path) || /^[A-Za-z]:|\\/.test(path))
      throw new CodeMemoryError(
        "PATH_OUT_OF_SCOPE",
        "Use a project-relative path with forward slashes",
      );
    const actual = await safePath(this.context, path);
    const handle = await open(actual, constants.O_RDONLY | constants.O_NOFOLLOW);
    try {
      const info = await handle.stat();
      if (!info.isFile())
        throw new CodeMemoryError("INVALID_EVIDENCE", "Checkpoint target must be a regular file");
      if (info.size > 2 * 1024 * 1024 || info.size > budget.bytes)
        throw new CodeMemoryError(
          "CHECKPOINT_READ_LIMIT",
          "Checkpoint source read budget exceeded",
        );
      // Read one extra byte to detect growth without an unbounded allocation.
      const buffer = Buffer.alloc(info.size + 1);
      let length = 0;
      while (length < buffer.length) {
        const { bytesRead } = await handle.read(buffer, length, buffer.length - length, null);
        if (!bytesRead) break;
        length += bytesRead;
      }
      budget.bytes -= length;
      const after = await handle.stat();
      if (length !== info.size || after.mtimeMs !== info.mtimeMs || after.ctimeMs !== info.ctimeMs)
        throw new CodeMemoryError(
          "SOURCE_CHANGED",
          "Source changed during checkpoint observation; retry",
        );
      return {
        path: slash(relative(this.context.canonicalRoot, actual)),
        contentHash: hash(buffer.subarray(0, length)),
      };
    } finally {
      await handle.close();
    }
  }
  async capture(input: unknown) {
    const p = checkpointSchema.parse(input);
    const budget = checkpointBudget();
    const links: MemoryCheckpoint["links"] = [];
    for (const link of p.links)
      links.push({ ...link, ...(await this.fingerprint(link.path, budget)) });
    if (
      new Set(links.map((l) => JSON.stringify([l.path, l.role, l.locator]))).size !== links.length
    )
      throw new CodeMemoryError("INVALID_EVIDENCE", "Duplicate checkpoint link");
    const checkpoint: MemoryCheckpoint = {
      ...p,
      links,
      id: randomUUID(),
      createdAt: new Date().toISOString(),
    };
    await this.store.saveMemoryCheckpoint(this.context, checkpoint);
    return {
      checkpoint,
      policy:
        "File hashes are observed by the server. Implementation, locators and test results are caller reports, not independently verified behavior. No tests were executed by this operation.",
    };
  }
  async inspect(checkpoint: MemoryCheckpoint, budget = checkpointBudget()) {
    const links = [];
    for (const link of checkpoint.links) {
      let freshness: string;
      let reason: string | undefined;
      try {
        const current = await this.fingerprint(link.path, budget);
        freshness = current.contentHash === link.contentHash ? "UNCHANGED" : "CHANGED";
      } catch (error) {
        reason = error instanceof CodeMemoryError ? error.code : "SOURCE_UNREADABLE";
        freshness =
          error instanceof CodeMemoryError && error.code === "NOT_FOUND" ? "MISSING" : "UNKNOWN";
      }
      links.push({ ...link, freshness, reason, locatorVerification: "CALLER_REPORTED" });
    }
    return {
      ...checkpoint,
      links,
      sourceState: !links.length
        ? "NO_SOURCE_EVIDENCE"
        : links.every((l) => l.freshness === "UNCHANGED")
          ? "UNCHANGED"
          : "RECHECK_REQUIRED",
      behaviorVerification: "NOT_INDEPENDENTLY_VERIFIED",
      checkedAt: new Date().toISOString(),
    };
  }
  async list(input: unknown) {
    const p = checkpointReadSchema.parse(input);
    const rows = await this.store.memoryCheckpoints(
      this.context,
      p.memoryId,
      p.limit + 1,
      p.offset,
    );
    const budget = checkpointBudget();
    const results = [];
    for (const row of rows.slice(0, p.limit)) results.push(await this.inspect(row, budget));
    return {
      results,
      hasMore: rows.length > p.limit,
      nextOffset: rows.length > p.limit ? p.offset + p.limit : null,
      projectScopeId: this.context.projectScopeId,
    };
  }
}

import { rename, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodebaseService } from "@codememory/application";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it } from "vitest";

it("preserves checkpoint history, separates reports from proof, and checks live files across restart", async () => {
  const db = await testDatabase();
  const f = await fixture({
    "src/refund.ts": "export const refund = () => 1;",
    "schema.prisma": "model Refund { id Int @id }",
    "refund.test.ts": "// synthetic test reference",
  });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const app = new CodebaseService(c, db.store);
    const memory = await app.memory.remember({
      type: "DECISION",
      title: "Shared refunds",
      content: "Use the shared refund service.",
    });
    const input = {
      memoryId: memory.id,
      implementation: "REPORTED_IMPLEMENTED",
      note: "Implementation reported by test operator",
      links: [
        { path: "src/refund.ts", role: "IMPLEMENTATION", locator: "refund" },
        { path: "schema.prisma", role: "PRISMA_MODEL", locator: "Refund" },
        { path: "refund.test.ts", role: "TEST" },
      ],
      verification: "REPORTED_PASS",
      verificationNote: "Synthetic reported result; no command execution claimed by host.",
    };
    const first = await app.memoryWorkflow.checkpoints.capture(input);
    expect(first.checkpoint.links[0]?.contentHash).toHaveLength(64);
    const limited = await app.memoryWorkflow.checkpoints.inspect(first.checkpoint, { bytes: 0 });
    expect(limited.links[0]).toMatchObject({
      freshness: "UNKNOWN",
      reason: "CHECKPOINT_READ_LIMIT",
    });
    await app.memory.remember({
      type: "DECISION",
      title: "Other rule",
      content: "Unrelated rule",
      priority: 10,
    });
    expect(
      (await app.memoryWorkflow.recall({ paths: ["src/refund.ts"], limit: 1 })).results[0]?.id,
    ).toBe(memory.id);
    const restarted = new CodebaseService(c, db.store);
    const fresh = await restarted.memoryWorkflow.checkpoints.list({ memoryId: memory.id });
    expect(fresh.results[0]).toMatchObject({
      sourceState: "UNCHANGED",
      behaviorVerification: "NOT_INDEPENDENTLY_VERIFIED",
    });
    await writeFile(resolve(f.root, "src/refund.ts"), "export const refund = () => 2;");
    const recalled = await restarted.memoryWorkflow.recall({
      task: "refund",
      paths: ["src/refund.ts"],
    });
    expect(recalled.results[0]?.checkpoint).toMatchObject({
      sourceState: "RECHECK_REQUIRED",
      links: [{ freshness: "CHANGED" }, { freshness: "UNCHANGED" }],
      linksTruncated: true,
    });
    const second = await restarted.memoryWorkflow.checkpoints.capture(input);
    expect(second.checkpoint.id).not.toBe(first.checkpoint.id);
    const page = await restarted.memoryWorkflow.checkpoints.list({ memoryId: memory.id, limit: 1 });
    expect(page).toMatchObject({ hasMore: true, nextOffset: 1 });
    expect(page.results[0]?.sourceState).toBe("UNCHANGED");
    const historical = await restarted.memoryWorkflow.checkpoints.list({
      memoryId: memory.id,
      offset: 1,
    });
    expect(historical.results[0]?.id).toBe(first.checkpoint.id);
    expect(historical.results[0]?.sourceState).toBe("RECHECK_REQUIRED");
    await rename(resolve(f.root, "src/refund.ts"), resolve(f.root, "src/renamed.ts"));
    expect(
      (await restarted.memoryWorkflow.checkpoints.list({ memoryId: memory.id })).results[0]
        ?.links[0]?.freshness,
    ).toBe("MISSING");
    await restarted.memory.archive(memory.id);
    await expect(
      restarted.memoryWorkflow.checkpoints.capture({
        ...input,
        links: [],
        implementation: "REQUESTED",
        verification: "NOT_RUN",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect(
      (await restarted.memoryWorkflow.checkpoints.list({ memoryId: memory.id })).results,
    ).toHaveLength(1);
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

it("rejects cross-project writes, protected paths, symlink escapes and unsupported verification claims", async () => {
  const db = await testDatabase();
  const f = await fixture({ "a.ts": "export const a=1", ".env": "synthetic" });
  const other = await fixture({ "outside.ts": "synthetic" });
  try {
    const c = await createProjectContext(f.root),
      c2 = await createProjectContext(other.root);
    await db.store.register(c);
    await db.store.register(c2);
    const app = new CodebaseService(c, db.store),
      app2 = new CodebaseService(c2, db.store);
    const m = await app.memory.remember({
      type: "DECISION",
      title: "Rule",
      content: "Shared logic",
    });
    const input = {
      memoryId: m.id,
      implementation: "REQUESTED",
      note: "Requested only",
      links: [],
    };
    await app.memoryWorkflow.checkpoints.capture(input);
    expect(
      (await app.memoryWorkflow.checkpoints.list({ memoryId: m.id })).results[0]?.sourceState,
    ).toBe("NO_SOURCE_EVIDENCE");
    await expect(app2.memoryWorkflow.checkpoints.capture(input)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    expect((await app2.memoryWorkflow.checkpoints.list({ memoryId: m.id })).results).toEqual([]);
    for (const path of ["../outside.ts", ".env", f.root, "C:\\outside.ts"])
      await expect(
        app.memoryWorkflow.checkpoints.capture({
          ...input,
          links: [{ path, role: "IMPLEMENTATION" }],
        }),
      ).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
    await symlink(resolve(other.root, "outside.ts"), resolve(f.root, "escape.ts"));
    await expect(
      app.memoryWorkflow.checkpoints.capture({
        ...input,
        links: [{ path: "escape.ts", role: "IMPLEMENTATION" }],
      }),
    ).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
    await expect(
      app.memoryWorkflow.checkpoints.capture({ ...input, verification: "VERIFIED" }),
    ).rejects.toThrow();
    await expect(
      app.memoryWorkflow.checkpoints.capture({ ...input, verification: "REPORTED_PASS" }),
    ).rejects.toThrow();
    await writeFile(resolve(f.root, "big.ts"), Buffer.alloc(2 * 1024 * 1024 + 1));
    await expect(
      app.memoryWorkflow.checkpoints.capture({
        ...input,
        links: [{ path: "big.ts", role: "IMPLEMENTATION" }],
      }),
    ).rejects.toMatchObject({ code: "CHECKPOINT_READ_LIMIT" });
    await db.store.pool.query("DROP TABLE memory_checkpoints");
    expect((await app.memoryWorkflow.recall({ task: "Shared logic" })).results[0]?.id).toBe(m.id);
  } finally {
    await db.dispose();
    await f.dispose();
    await other.dispose();
  }
});

it("reads a shared source once per request but detects changes in the next request", async () => {
  const { MemoryCheckpointService, checkpointBudget } = await import(
    "../../packages/memory/src/checkpoints"
  );
  const db = await testDatabase();
  const f = await fixture({ "a.ts": "const a = 1;" });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const app = new CodebaseService(c, db.store);
    const m = await app.memory.remember({ type: "DECISION", title: "Shared", content: "Reuse" });
    const service = new MemoryCheckpointService(c, db.store);
    const captured = await service.capture({
      memoryId: m.id,
      implementation: "REPORTED_IMPLEMENTED",
      note: "Synthetic",
      links: [{ path: "a.ts", role: "IMPLEMENTATION" }],
    });
    const budget = checkpointBudget();
    await service.inspect(captured.checkpoint, budget);
    const remaining = budget.bytes;
    await service.inspect(captured.checkpoint, budget);
    expect(budget.bytes).toBe(remaining);
    await writeFile(resolve(f.root, "a.ts"), "const a = 2;");
    expect((await service.inspect(captured.checkpoint)).sourceState).toBe("RECHECK_REQUIRED");
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

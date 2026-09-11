import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodebaseService } from "@codememory/application";
import type { LanguagePlugin } from "@codememory/core";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it, vi } from "vitest";

it("publishes healthy files, reports source read failures and retries without content edits", async () => {
  const db = await testDatabase(),
    f = await fixture({
      "good.ts": "export const healthy=1",
      "bad.ts": "export const recoverable=2",
    });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    let fail = true;
    const scanner = new RepositoryScanner((event, path) => {
      if (fail && event === "read" && path.endsWith("/bad.ts"))
        throw Object.assign(new Error("simulated unreadable file"), { code: "EACCES" });
    });
    const index = new IndexService(c, db.store, scanner, new TypeScriptPlugin()),
      service = new CodebaseService(c, db.store);
    const noSnapshot = vi
      .spyOn(Object.getPrototypeOf(db.store), "snapshot")
      .mockRejectedValue(new Error("Unexpected full snapshot"));
    await index.index();
    expect(await service.execute("search_symbols", { query: "healthy" })).toMatchObject({
      incomplete: true,
      results: [{ name: "healthy" }],
    });
    expect(await db.store.status(c)).toMatchObject({
      incomplete: true,
      fileErrors: [{ path: "bad.ts", error: "EACCES" }],
      lastIndexJob: { state: "SUCCEEDED", stage: "COMPLETE", interrupted: false },
    });
    expect((await index.index()).reason).toBe("UNCHANGED");
    fail = false;
    expect((await index.index()).changed).toBe(1);
    expect(await service.execute("search_symbols", { query: "recoverable" })).toMatchObject({
      incomplete: false,
      results: [{ name: "recoverable" }],
    });
    expect((await db.store.status(c)).fileErrors).toEqual([]);
    expect(noSnapshot).not.toHaveBeenCalled();
    noSnapshot.mockRestore();
  } finally {
    vi.restoreAllMocks();
    await db.dispose();
    await f.dispose();
  }
});

it("records parser failure stages, preserves completed generation and recovers on retry", async () => {
  const db = await testDatabase(),
    f = await fixture({ "main.ts": "export const before=1" });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const parser = new TypeScriptPlugin();
    let fail = false;
    const plugin: LanguagePlugin = {
      id: parser.id,
      version: parser.version,
      extensions: parser.extensions,
      analyze: async (...args) => {
        expect((await db.store.status(c)).lastIndexJob).toMatchObject({
          state: "RUNNING",
          stage: "ANALYZING",
          interrupted: false,
        });
        if (fail) throw new Error("simulated parser crash");
        return parser.analyze(...args);
      },
    };
    const index = new IndexService(c, db.store, new RepositoryScanner(), plugin);
    await index.index();
    const before = await db.store.snapshot(c);
    fail = true;
    await writeFile(resolve(f.root, "main.ts"), "export const after=2");
    await expect(index.index()).rejects.toThrow("simulated parser crash");
    expect((await db.store.snapshot(c)).version).toBe(before.version);
    expect((await db.store.status(c)).lastIndexJob).toMatchObject({
      state: "FAILED",
      stage: "ANALYZING",
      error: "INDEX_ERROR",
    });
    fail = false;
    expect((await index.index()).version).toBe(before.version + 1);
    expect((await db.store.status(c)).lastIndexJob).toMatchObject({
      state: "SUCCEEDED",
      stage: "COMPLETE",
    });
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

it("detects abandoned progress after lock release and reconciles it without deleting the graph", async () => {
  const db = await testDatabase(),
    f = await fixture({ "main.ts": "export const kept=1" });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const index = new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin());
    await index.index();
    await db.store.locked(c, async (store) => {
      const now = new Date().toISOString();
      await store.recordIndexProgress(c, {
        state: "RUNNING",
        stage: "PUBLISHING",
        startedAt: now,
        updatedAt: now,
      });
      expect((await db.store.status(c)).lastIndexJob).toMatchObject({ interrupted: false });
    });
    expect((await db.store.status(c)).lastIndexJob).toMatchObject({
      interrupted: true,
      recovery: expect.stringContaining("Run index"),
    });
    expect((await index.index()).reason).toBe("UNCHANGED");
    expect((await db.store.status(c)).lastIndexJob).toMatchObject({
      state: "SUCCEEDED",
      interrupted: false,
    });
    expect((await db.store.snapshot(c)).symbols.some((s) => s.name === "kept")).toBe(true);
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

it("survives loss of the lock-owning connection during analysis and releases its pool slot", async () => {
  const db = await testDatabase(),
    f = await fixture({ "main.ts": "export const retained=1" });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const parser = new TypeScriptPlugin();
    let disconnect = false;
    const plugin: LanguagePlugin = {
      id: parser.id,
      version: parser.version,
      extensions: parser.extensions,
      analyze: async (...args) => {
        if (disconnect) {
          const { rows } = await db.store.pool.query(
            "SELECT backend_pid FROM index_jobs WHERE repository_id=$1",
            [c.projectScopeId],
          );
          await db.store.pool.query("SELECT pg_terminate_backend($1)", [rows[0].backend_pid]);
          await new Promise((resolve) => setTimeout(resolve, 50));
        }
        return parser.analyze(...args);
      },
    };
    const index = new IndexService(c, db.store, new RepositoryScanner(), plugin);
    await index.index();
    disconnect = true;
    await writeFile(resolve(f.root, "main.ts"), "export const updated=2");
    await expect(index.index()).rejects.toBeDefined();
    expect((await db.store.status(c)).lastIndexJob).toMatchObject({ interrupted: true });
    disconnect = false;
    expect((await index.index()).version).toBe(2);
    expect((await db.store.snapshot(c)).symbols.some((s) => s.name === "updated")).toBe(true);
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

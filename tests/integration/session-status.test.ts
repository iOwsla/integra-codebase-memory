import { mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodebaseService } from "@codememory/application";
import { IndexService, ProjectSession, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { eventually, fixture, testDatabase } from "@codememory/test-utils";
import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.restoreAllMocks());

it("does not report a RUNNING job without its lock as updating", async () => {
  const db = await testDatabase(),
    f = await fixture({ "a.ts": "export function a(){ return 1 }\nexport const b=()=>a()" });
  const pool = new pg.Pool({ connectionString: db.url });
  const c = await createProjectContext(f.root);
  const index = new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin());
  const session = new ProjectSession(c, db.store, index, false, false);
  try {
    await session.start();
    await index.index();
    // Simulate a process killed mid-index: the row says RUNNING but nobody holds the lock.
    await pool.query("UPDATE index_jobs SET backend_pid=0,data=data||$2 WHERE repository_id=$1", [
      c.projectScopeId,
      JSON.stringify({ state: "RUNNING", stage: "ANALYZING", startedAt: new Date().toISOString() }),
    ]);
    const status = await session.status();
    expect(status).toMatchObject({
      freshness: "LAST_COMPLETED",
      pendingChanges: 0,
      staleSince: null,
      state: "READY",
      lastIndexJob: { state: "RUNNING", lockActive: false, interrupted: true },
    });
    // The query overlay adds nothing beyond the persisted index metadata.
    const service = new CodebaseService(c, db.store, session);
    const metadata = await db.store.readIndex(c, async (_reader, m) => m);
    const result = await service.execute("search_symbols", { query: "a" });
    expect(result.freshness).toBe(metadata.freshness);
    expect(result.pendingChanges).toBe(0);
  } finally {
    await session.close();
    await pool.end();
    await f.dispose();
    await db.dispose();
  }
});

it("serves queries from in-memory session state without the status query", async () => {
  const db = await testDatabase(),
    f = await fixture({
      "a.ts": "export function a(){ return 1 }\nexport const b=()=>a()",
      // Keep the watcher change pending while the query runs.
      ".codememory/config.json": JSON.stringify({ debounceMs: 10000 }),
    });
  const c = await createProjectContext(f.root);
  const index = new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin());
  const session = new ProjectSession(c, db.store, index, false, true);
  try {
    await session.start();
    await index.index();
    const service = new CodebaseService(c, db.store, session);
    const symbolId = (
      (await service.execute("search_symbols", { query: "a" })).results as {
        id: string;
        name: string;
      }[]
    ).find((s) => s.name === "a")?.id;
    expect(symbolId).toBeDefined();
    await writeFile(resolve(f.root, "c.ts"), "export const c=1");
    await eventually(async () => session.liveState().pendingChanges > 0);
    const status = vi.spyOn(db.store, "status");
    const result = await service.execute("find_callers", { symbolId });
    expect(status).not.toHaveBeenCalled();
    expect(result).toMatchObject({ freshness: "UPDATING", incomplete: true });
    expect(result.pendingChanges).toBeGreaterThan(0);
    expect(typeof result.staleSince).toBe("string");
  } finally {
    await session.close();
    await f.dispose();
    await db.dispose();
  }
});

it("serves file tools from the indexed snapshot after the file is deleted on disk", async () => {
  const db = await testDatabase(),
    f = await fixture({
      "src/gone.ts": "export function gone(){\n  return 1\n}\n",
      "keep.ts": "export const keep=1",
    });
  const c = await createProjectContext(f.root);
  try {
    await db.store.register(c);
    await new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin()).index();
    await rm(resolve(f.root, "src/gone.ts"));
    const service = new CodebaseService(c, db.store);
    const context = await service.execute("get_file_context", { path: "src/gone.ts", line: 1 });
    expect(context).toMatchObject({ sourceOnDisk: false });
    expect(JSON.stringify(context)).toContain("export function gone");
    expect(
      await service.execute("get_file_outline", { path: "./src/../src/gone.ts" }),
    ).toMatchObject({ sourceOnDisk: false });
    const present = await service.execute("get_file_context", { path: "keep.ts", line: 1 });
    expect(present).not.toHaveProperty("sourceOnDisk");
    await expect(
      service.execute("get_file_context", { path: "never.ts", line: 1 }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      service.execute("get_file_context", { path: ".env.local", line: 1 }),
    ).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
    await expect(
      service.execute("get_file_context", { path: "../outside.ts", line: 1 }),
    ).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
    await mkdir(resolve(f.root, "nested/.git"), { recursive: true });
    await expect(
      service.execute("get_file_context", { path: "nested/missing.ts", line: 1 }),
    ).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
  } finally {
    await f.dispose();
    await db.dispose();
  }
});

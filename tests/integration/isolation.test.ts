import { rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodebaseService } from "@codememory/application";
import { IndexService, ProjectSession, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { eventually, fixture, testDatabase } from "@codememory/test-utils";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

describe("PostgreSQL / session isolation acceptance", () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => {
    db = await testDatabase();
  });
  afterAll(async () => {
    await db?.dispose();
  });
  it("A–G: only selected sources are touched; parallel sessions, memories and shutdown stay isolated", async () => {
    const a = await fixture({ "a.ts": "export function onlyA(){return 1}" }),
      b = await fixture({ "b.ts": "export function onlyB(){return 2}" });
    const ca = await createProjectContext(a.root),
      cb = await createProjectContext(b.root);
    const calls: { event: string; path: string }[] = [];
    const observe = (event: string, path: string) => calls.push({ event, path });
    const ia = new IndexService(
        ca,
        db.store,
        new RepositoryScanner(observe),
        new TypeScriptPlugin((p) => observe("parse", p)),
      ),
      ib = new IndexService(
        cb,
        db.store,
        new RepositoryScanner(observe),
        new TypeScriptPlugin((p) => observe("parse", p)),
      );
    const sa = new ProjectSession(ca, db.store, ia, true, true, observe),
      sb = new ProjectSession(cb, db.store, ib, true, true, observe);
    try {
      await db.store.register(cb);
      await sa.start();
      await eventually(async () => !!(await db.store.status(ca)).version);
      expect(calls.every((c) => c.path.startsWith(a.root))).toBe(true);
      expect((await db.store.status(cb)).version).toBe(0);
      await writeFile(resolve(b.root, "b.ts"), "export function onlyB(){return 3}");
      await new Promise((r) => setTimeout(r, 500));
      expect((await db.store.status(cb)).version).toBe(0);
      expect(calls.every((c) => c.path.startsWith(a.root))).toBe(true);
      await writeFile(resolve(a.root, "a.ts"), "export function onlyA(){return 4}");
      await eventually(async () => Number((await db.store.status(ca)).version) > 1);
      expect(calls.every((c) => c.path.startsWith(a.root))).toBe(true);
      await sb.start();
      await eventually(async () => !!(await db.store.status(cb)).version);
      const as = new CodebaseService(ca, db.store, sa),
        bs = new CodebaseService(cb, db.store, sb);
      expect(
        JSON.stringify((await as.execute("search_symbols", { query: "onlyB" })).results),
      ).not.toContain("onlyB");
      const bm = await bs.memory.remember({
        type: "DECISION",
        title: "B private",
        content: "B private content",
      });
      expect((await as.memory.search("private")).results).toEqual([]);
      const bid = (await db.store.snapshot(cb)).symbols.find((s) => s.name === "onlyB")!.id;
      await expect(as.execute("get_symbol", { symbolId: bid })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
      await expect(
        as.execute("get_file_context", { path: resolve(b.root, "b.ts"), line: 1 }),
      ).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
      await expect(
        as.memory.remember({ type: "NOTE", title: "bad", content: "bad", supersedes: bm.id }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
      await expect(as.memory.archive(bm.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
      await sa.close();
      const av = (await db.store.status(ca)).version;
      await writeFile(resolve(a.root, "a.ts"), "export const afterClose=1");
      await writeFile(resolve(b.root, "b.ts"), "export const stillWatching=1");
      await eventually(async () => Number((await db.store.status(cb)).version) > 1);
      expect((await db.store.status(ca)).version).toBe(av);
      expect((await sa.status()).watcher).toBe(false);
    } finally {
      await sa.close();
      await sb.close();
      await a.dispose();
      await b.dispose();
    }
  });
  it("I–J: no-op reopen preserves rows; export changes repair unchanged callers, deletion has no dangling edges", async () => {
    const f = await fixture({
      "target.ts": "export function target(){return 1}",
      "caller.ts": "import {target} from './target'; export function caller(){return target()}",
    });
    try {
      const c = await createProjectContext(f.root);
      await db.store.register(c);
      let parses = 0;
      const index = new IndexService(
        c,
        db.store,
        new RepositoryScanner(),
        new TypeScriptPlugin(() => parses++),
      );
      await index.index();
      const before = await db.store.snapshot(c);
      const rows = await db.store.pool.query(
        "SELECT id,xmin::text FROM symbols WHERE repository_id=$1",
        [c.projectScopeId],
      );
      const edges = await db.store.pool.query(
        "SELECT id,xmin::text FROM symbol_edges WHERE repository_id=$1",
        [c.projectScopeId],
      );
      const count = parses;
      expect((await index.index()).reason).toBe("UNCHANGED");
      expect(parses).toBe(count);
      expect(
        (
          await db.store.pool.query("SELECT id,xmin::text FROM symbols WHERE repository_id=$1", [
            c.projectScopeId,
          ])
        ).rows,
      ).toEqual(rows.rows);
      expect(
        (
          await db.store.pool.query(
            "SELECT id,xmin::text FROM symbol_edges WHERE repository_id=$1",
            [c.projectScopeId],
          )
        ).rows,
      ).toEqual(edges.rows);
      const oldId = before.symbols.find((s) => s.name === "target" && s.kind === "FUNCTION")!.id;
      await writeFile(resolve(f.root, "target.ts"), "export function renamed(){return 1}");
      await index.index();
      const after = await db.store.snapshot(c);
      expect(after.symbols.some((s) => s.id === oldId)).toBe(false);
      expect(after.edges.some((e) => e.target === oldId)).toBe(false);
      expect(after.unresolved.some((u) => u.expression === "target()")).toBe(true);
      await rm(resolve(f.root, "target.ts"));
      await index.index();
      const deleted = await db.store.snapshot(c);
      const ids = new Set(deleted.symbols.map((s) => s.id));
      expect(deleted.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
      const service = new CodebaseService(c, db.store);
      await service.memory.remember({ type: "NOTE", title: "keep", content: "survives clean" });
      await db.store.clean(c);
      expect((await service.memory.search("keep")).results).toHaveLength(1);
      await expect(service.execute("search_symbols", { query: "caller" })).rejects.toMatchObject({
        code: "INDEX_NOT_READY",
      });
    } finally {
      await f.dispose();
    }
  });
  it("serializes same-project writers and rolls back a failed publication", async () => {
    const f = await fixture({ "main.ts": "export const x=1" });
    try {
      const c = await createProjectContext(f.root);
      await db.store.register(c);
      const index = new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin());
      await index.index();
      await db.store.locked(c, async () => {
        await expect(index.index()).rejects.toMatchObject({ code: "INDEX_BUSY" });
      });
      const old = await db.store.snapshot(c);
      await expect(
        db.store.locked(c, (store) =>
          store.publish(
            c,
            {
              ...old,
              version: 99,
              edges: [
                {
                  id: "bad",
                  source: "nonexistent",
                  target: "nonexistent",
                  type: "CALLS",
                  resolution: "AST_CONFIRMED",
                  confidence: 1,
                  fileId: "bad",
                  line: 1,
                },
              ],
            },
            [],
            [],
            { version: 99, changed: 0, deleted: 0, excluded: 0, reason: "test", indexedAt: null },
          ),
        ),
      ).rejects.toBeDefined();
      expect((await db.store.snapshot(c)).version).toBe(old.version);
      expect((await db.store.snapshot(c)).edges).toEqual(old.edges);
    } finally {
      await f.dispose();
    }
  });
});

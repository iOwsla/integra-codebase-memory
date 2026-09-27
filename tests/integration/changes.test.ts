import { rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodebaseService } from "@codememory/application";
import { IndexService, ProjectSession, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { eventually, fixture, testDatabase } from "@codememory/test-utils";
import { expect, it } from "vitest";

it("watch reconciles untracked additions, rename and delete; unchanged content coalesces", async () => {
  const db = await testDatabase(),
    f = await fixture({ "one.ts": "export const one=1" });
  const c = await createProjectContext(f.root),
    index = new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin()),
    session = new ProjectSession(c, db.store, index, true, true);
  try {
    await session.start();
    await eventually(async () => Number((await db.store.status(c)).version) > 0);
    await writeFile(resolve(f.root, "new.ts"), "export const added=2");
    await eventually(async () =>
      (await db.store.snapshot(c)).symbols.some((s) => s.name === "added"),
    );
    await rename(resolve(f.root, "new.ts"), resolve(f.root, "renamed.ts"));
    await eventually(async () =>
      (await db.store.snapshot(c)).files.some((f) => f.path === "renamed.ts"),
    );
    const snapshot = await db.store.snapshot(c);
    expect(snapshot.files.some((f) => f.path === "new.ts")).toBe(false);
    await writeFile(resolve(f.root, "one.ts"), "export const one=1");
    await new Promise((r) => setTimeout(r, 600));
    expect((await db.store.snapshot(c)).version).toBe(snapshot.version);
  } finally {
    await session.close();
    await f.dispose();
    await db.dispose();
  }
});
it("config/parser fingerprint invalidates unchanged files and parser diagnostics are explicit", async () => {
  const db = await testDatabase(),
    f = await fixture({ "a.ts": "export function broken( {", "b.ts": "export const b=2" });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    await new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin()).index();
    const service = new CodebaseService(c, db.store);
    expect((await service.execute("search_symbols", { query: "b" })).incomplete).toBe(true);
    const plugin = new TypeScriptPlugin();
    Object.defineProperty(plugin, "version", { value: "regression-v2" });
    const result = await new IndexService(c, db.store, new RepositoryScanner(), plugin).index();
    expect(result.reason).toBe("PARSER_CONFIG_SCHEMA_CHANGED");
    expect(result.changed).toBe(2);
  } finally {
    await f.dispose();
    await db.dispose();
  }
});
it("does not reanalyze source when only watcher timing changes", async () => {
  const db = await testDatabase();
  const f = await fixture({ "a.ts": "export const a=1" });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    await new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin()).index();
    const updated = {
      ...c,
      effectiveConfig: { ...c.effectiveConfig, reconcileMs: 600000, debounceMs: 1000 },
    };
    const result = await new IndexService(
      updated,
      db.store,
      new RepositoryScanner(),
      new TypeScriptPlugin(),
    ).index();
    expect(result.reason).toBe("UNCHANGED");
    expect(result.changed).toBe(0);
  } finally {
    await f.dispose();
    await db.dispose();
  }
});
it("J: inferred receiver type change redirects calls from unchanged dependent files", async () => {
  const db = await testDatabase(),
    f = await fixture({
      "target.ts":
        "export class A {run(){return 1}} export class B {run(){return 2}} export const receiver=new A();",
      "caller.ts":
        "import {receiver} from './target'; export function caller(){return receiver.run()}",
    });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const index = new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin());
    await index.index();
    const before = await db.store.snapshot(c),
      oldTarget = before.symbols.find((s) => s.qualifiedName === "A.run")?.id;
    expect(before.edges.some((e) => e.type === "CALLS" && e.target === oldTarget)).toBe(true);
    await writeFile(
      resolve(f.root, "target.ts"),
      "export class A {run(){return 1}} export class B {run(){return 2}} export const receiver=new B();",
    );
    await index.index();
    const after = await db.store.snapshot(c),
      target = after.symbols.find((s) => s.qualifiedName === "B.run")?.id;
    expect(after.edges.some((e) => e.type === "CALLS" && e.target === target)).toBe(true);
    expect(after.edges.some((e) => e.type === "CALLS" && e.target === oldTarget)).toBe(false);
  } finally {
    await f.dispose();
    await db.dispose();
  }
});
it("retains relationships from unaffected files and removes deleted-file references", async () => {
  const db = await testDatabase();
  const f = await fixture({
    "a.ts": "export function a(){return missingA()}",
    "b.ts": "export function b(){return missingB()}",
    "c.ts": "export function local(){} export function c(){return local()}",
  });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const index = new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin());
    await index.index();
    const before = await db.store.snapshot(c);
    const stable = before.edges.find((edge) =>
      before.symbols.some((symbol) => symbol.id === edge.source && symbol.file === "c.ts"),
    );
    expect(stable).toBeDefined();
    if (!stable) throw new Error("Expected a stable relationship");
    const owner = before.files.find((file) => file.path === "c.ts")?.id;
    expect(owner).toBeDefined();
    const first = await db.store.pool.query(
      "SELECT xmin::text AS created FROM symbol_edges WHERE repository_id=$1 AND id=$2",
      [c.projectScopeId, stable.id],
    );
    await writeFile(resolve(f.root, "a.ts"), "export function a(){return 1}");
    await index.index();
    const second = await db.store.pool.query(
      "SELECT xmin::text AS created,file_id FROM symbol_edges WHERE repository_id=$1 AND id=$2",
      [c.projectScopeId, stable.id],
    );
    expect(second.rows).toEqual([{ created: first.rows[0].created, file_id: owner }]);
    await rename(resolve(f.root, "b.ts"), resolve(f.root, "renamed.ts"));
    await index.index();
    const after = await db.store.snapshot(c);
    const status = await db.store.status(c);
    expect(status.last_run?.totals).toEqual({
      files: after.files.length,
      symbols: after.symbols.length,
      edges: after.edges.length,
      unresolvedReferences: after.unresolved.length,
    });
    expect([status.files, status.symbols, status.edges, status.unresolvedReferences]).toEqual([
      after.files.length,
      after.symbols.length,
      after.edges.length,
      after.unresolved.length,
    ]);
    const deletedId = before.files.find((file) => file.path === "b.ts")?.id;
    const renamedId = after.files.find((file) => file.path === "renamed.ts")?.id;
    expect(deletedId).toBeDefined();
    expect(renamedId).toBeDefined();
    expect(after.unresolved.some((reference) => reference.fileId === deletedId)).toBe(false);
    expect(after.unresolved.some((reference) => reference.fileId === renamedId)).toBe(true);
    await db.store.pool.query("UPDATE index_runs SET data=data-'totals' WHERE repository_id=$1", [
      c.projectScopeId,
    ]);
    expect((await db.store.status(c)).edges).toBe(after.edges.length);
  } finally {
    await f.dispose();
    await db.dispose();
  }
});
it("recovers when PostgreSQL disconnects an idle pooled connection", async () => {
  const db = await testDatabase();
  const { default: pg } = await import("pg");
  const killer = new pg.Client({ connectionString: db.url });
  try {
    expect(db.store.pool.listenerCount("error")).toBeGreaterThan(0);
    const pid = (await db.store.pool.query("SELECT pg_backend_pid() AS pid")).rows[0].pid;
    await killer.connect();
    const disconnected = new Promise<void>((resolve) =>
      db.store.pool.once("error", () => resolve()),
    );
    await killer.query("SELECT pg_terminate_backend($1)", [pid]);
    await disconnected;
    expect((await db.store.diagnostics()).database).toBe("connected");
  } finally {
    await killer.end();
    await db.dispose();
  }
});
it("re-resolves workspace consumers after only package exports metadata changes", async () => {
  const db = await testDatabase(),
    f = await fixture({
      "package.json": '{"workspaces":["lib"]}',
      "lib/package.json": '{"name":"lib","exports":"./old.ts"}',
      "lib/old.ts": "export function api(){return 1}",
      "lib/new.ts": "export function api(){return 2}",
      "main.ts": "import {api} from 'lib';export function run(){return api()}",
    });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const index = new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin());
    await index.index();
    const old = await db.store.snapshot(c),
      oldId = old.symbols.find((s) => s.file === "lib/old.ts" && s.kind === "FUNCTION")?.id;
    expect(old.edges.some((e) => e.type === "CALLS" && e.target === oldId)).toBe(true);
    await writeFile(resolve(f.root, "lib/package.json"), '{"name":"lib","exports":"./new.ts"}');
    expect((await index.index()).reason).toBe("PARSER_CONFIG_SCHEMA_CHANGED");
    const updated = await db.store.snapshot(c),
      newId = updated.symbols.find((s) => s.file === "lib/new.ts" && s.kind === "FUNCTION")?.id;
    expect(updated.edges.some((e) => e.type === "CALLS" && e.target === newId)).toBe(true);
    expect(updated.edges.some((e) => e.type === "CALLS" && e.target === oldId)).toBe(false);
    expect((await index.index()).reason).toBe("UNCHANGED");
  } finally {
    await f.dispose();
    await db.dispose();
  }
});

import { rm } from "node:fs/promises";
import { resolve } from "node:path";
import { CodebaseService } from "@codememory/application";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it, vi } from "vitest";

async function setup() {
  const db = await testDatabase(),
    f = await fixture({
      "src/a.ts": "export const a=1",
      "nested/.git/HEAD": "ref: refs/heads/main",
    }),
    c = await createProjectContext(f.root);
  await db.store.register(c);
  return {
    db,
    f,
    c,
    service: new CodebaseService(c, db.store),
    dispose: async () => {
      await db.dispose();
      await f.dispose();
    },
  };
}
const note = { type: "NOTE", title: "shared", content: "literal 100%_value\\x" };

it("filters type, all tags and exact scope with SQL pages even before indexing", async () => {
  const t = await setup();
  try {
    const repo = await t.service.memory.remember({ ...note, tags: ["api", "stable"] });
    const file = await t.service.memory.remember({
      ...note,
      type: "WARNING",
      tags: ["api", "stable"],
      scope: { type: "file", target: resolve(t.f.root, "src/./a.ts") },
    });
    await t.service.memory.remember({
      ...note,
      type: "DECISION",
      tags: ["api"],
      scope: { type: "directory", target: "src" },
    });
    const noMemory = vi
      .spyOn(t.db.store, "memories")
      .mockRejectedValue(new Error("full memory read"));
    const noSnapshot = vi
      .spyOn(t.db.store, "snapshot")
      .mockRejectedValue(new Error("full index read"));
    expect(file.scope.target).toBe("src/a.ts");
    expect(
      await t.service.execute("search_memory", {
        query: "%_value\\",
        types: ["WARNING", "NOTE"],
        tags: ["api", "stable"],
        scope: { type: "file", target: "./src/a.ts" },
      }),
    ).toMatchObject({ results: [{ id: file.id }], hasMore: false, nextOffset: 20 });
    expect((await t.service.execute("search_memory", { tags: ["API"] })).results).toEqual([]);
    expect(
      (await t.service.execute("search_memory", { types: ["DECISION"], tags: ["stable"] })).results,
    ).toEqual([]);
    expect(
      (await t.service.execute("search_memory", { scope: { type: "repository" } })).results,
    ).toMatchObject([{ id: repo.id }]);
    expect(
      (await t.service.execute("search_memory", { scope: { type: "file" } })).results,
    ).toHaveLength(1);
    const first = await t.service.execute("search_memory", { limit: 1 });
    const second = await t.service.execute("search_memory", { limit: 1, offset: 1 });
    expect(first.hasMore).toBe(true);
    expect(first.nextOffset).toBe(1);
    expect(first.results).not.toEqual(second.results);
    expect(await t.service.execute("search_memory", { limit: 1, offset: 1 })).toEqual(second);
    expect((await t.service.execute("search_memory", { limit: 1, offset: 3 })).results).toEqual([]);
    expect(noMemory).not.toHaveBeenCalled();
    expect(noSnapshot).not.toHaveBeenCalled();
    noMemory.mockRestore();
    noSnapshot.mockRestore();
  } finally {
    await t.dispose();
  }
});

it("retains scoped memories through file deletion and code cleanup", async () => {
  const t = await setup();
  try {
    await new IndexService(
      t.c,
      t.db.store,
      new RepositoryScanner(),
      new TypeScriptPlugin(),
    ).index();
    const id = (await t.db.store.snapshot(t.c)).symbols.find((s) => s.name === "a")!.id;
    const noSnapshot = vi.spyOn(t.db.store, "snapshot").mockRejectedValue(new Error("unbounded"));
    const symbol = await t.service.memory.remember({
      ...note,
      scope: { type: "symbol", target: id },
    });
    const file = await t.service.memory.remember({
      ...note,
      scope: { type: "file", target: "src/a.ts" },
    });
    noSnapshot.mockRestore();
    await rm(resolve(t.f.root, "src/a.ts"));
    await t.db.store.clean(t.c);
    expect(
      (await t.service.execute("search_memory", { scope: { type: "symbol", target: id } })).results,
    ).toMatchObject([{ id: symbol.id }]);
    expect(
      (await t.service.execute("search_memory", { scope: { type: "file", target: "src/a.ts" } }))
        .results,
    ).toMatchObject([{ id: file.id }]);
    await expect(
      t.service.memory.remember({ ...note, scope: { type: "symbol", target: id } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await t.db.store.clean(t.c, true);
    expect((await t.service.memory.search("")).results).toEqual([]);
  } finally {
    await t.dispose();
  }
});

it("rejects invalid scopes, foreign symbols, mutations and filter injection", async () => {
  const t = await setup(),
    other = await fixture({ "foreign.ts": "export const foreign=1" });
  try {
    const c = await createProjectContext(other.root);
    await t.db.store.register(c);
    await new IndexService(c, t.db.store, new RepositoryScanner(), new TypeScriptPlugin()).index();
    const service = new CodebaseService(c, t.db.store),
      old = await service.memory.remember(note);
    const id = (await t.db.store.snapshot(c)).symbols.find((s) => s.name === "foreign")!.id;
    for (const input of [
      { scope: { type: "repository", target: "x" } },
      { scope: { type: "file", target: "src" } },
      { scope: { type: "directory", target: "src/a.ts" } },
      { scope: { type: "file" } },
    ])
      await expect(t.service.memory.remember({ ...note, ...input })).rejects.toMatchObject({
        code: "INVALID_SCOPE",
      });
    await expect(
      t.service.memory.remember({ ...note, scope: { type: "symbol", target: id } }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      t.service.memory.remember({ ...note, scope: { type: "directory", target: "nested" } }),
    ).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
    await expect(t.service.memory.remember({ ...note, supersedes: old.id })).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    await expect(t.service.memory.archive(old.id)).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await t.service.memory.search("")).results).toEqual([]);
    await expect(
      t.service.execute("search_memory", {
        scope: { type: "file", target: resolve(other.root, "foreign.ts") },
      }),
    ).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
    for (const args of [
      { repositoryId: c.projectScopeId },
      { types: ["INVALID"] },
      { limit: 101 },
      { offset: -1 },
      { scope: { type: "global" } },
      { tags: [""] },
    ])
      await expect(t.service.execute("search_memory", args)).rejects.toBeDefined();
    expect((await service.memory.search("")).results).toMatchObject([
      { id: old.id, status: "ACTIVE" },
    ]);
  } finally {
    await other.dispose();
    await t.dispose();
  }
});

it("supersedes once under concurrent writers and archives without hiding history", async () => {
  const t = await setup();
  try {
    const old = await t.service.memory.remember(note);
    const attempts = await Promise.allSettled(
      [1, 2].map((n) =>
        t.service.memory.remember({ ...note, title: `replacement ${n}`, supersedes: old.id }),
      ),
    );
    expect(attempts.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(attempts.filter((r) => r.status === "rejected")).toHaveLength(1);
    const active = (await t.service.memory.search("")).results;
    expect(active).toHaveLength(1);
    const all = (await t.service.execute("search_memory", { includeInactive: true })).results;
    expect(all).toHaveLength(2);
    expect(all).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ id: old.id, status: "SUPERSEDED", supersededBy: active[0]!.id }),
      ]),
    );
    await t.service.memory.archive(active[0]!.id);
    expect((await t.service.memory.search("")).results).toEqual([]);
    expect(
      (await t.service.execute("search_memory", { includeInactive: true, types: ["NOTE"] }))
        .results,
    ).toHaveLength(2);
  } finally {
    await t.dispose();
  }
});

it("upgrades memory indexes without rewriting records and recognizes legacy path spellings", async () => {
  const t = await setup();
  try {
    const memory = await t.service.memory.remember({
      ...note,
      scope: { type: "file", target: "src/a.ts" },
    });
    await t.db.store.pool.query(
      "UPDATE memories SET data=jsonb_set(data,'{scope,target}',to_jsonb($2::text)) WHERE id=$1",
      [memory.id, resolve(t.f.root, "src/a.ts")],
    );
    const before = (await t.db.store.pool.query("SELECT id,xmin::text FROM memories")).rows;
    await t.db.store.pool.query(
      "DROP INDEX memories_page,memories_type_status,memories_scope,memories_tags; DELETE FROM schema_migrations WHERE version=3",
    );
    await t.db.store.migrate();
    await t.db.store.migrate();
    expect((await t.db.store.pool.query("SELECT id,xmin::text FROM memories")).rows).toEqual(
      before,
    );
    expect(
      (await t.service.execute("search_memory", { scope: { type: "file", target: "src/a.ts" } }))
        .results,
    ).toMatchObject([{ id: memory.id }]);
  } finally {
    await t.dispose();
  }
});

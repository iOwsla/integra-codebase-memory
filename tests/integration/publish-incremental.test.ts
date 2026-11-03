import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodebaseService } from "@codememory/application";
import type { IndexResult, ProjectContext, Snapshot } from "@codememory/core";
import type { PostgresStore } from "@codememory/database";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import pg from "pg";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => {
  vi.restoreAllMocks();
});

async function indexed(files: Record<string, string>) {
  const db = await testDatabase(),
    f = await fixture(files);
  const c = await createProjectContext(f.root);
  await db.store.register(c);
  const index = new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin());
  await index.index();
  return {
    db,
    f,
    c,
    index,
    service: new CodebaseService(c, db.store),
    dispose: async () => {
      await db.dispose();
      await f.dispose();
    },
  };
}
type Indexed = Awaited<ReturnType<typeof indexed>>;

/** Every graph row of the project, keyed by id, for byte-level comparison. */
async function graph(t: Indexed) {
  const rows = async (table: string) =>
    (
      await t.db.store.pool.query(
        `SELECT id,data FROM ${table} WHERE repository_id=$1 ORDER BY id COLLATE "C"`,
        [t.c.projectScopeId],
      )
    ).rows;
  return {
    symbols: await rows("symbols"),
    edges: await rows("symbol_edges"),
    unresolved: await rows("unresolved_references"),
  };
}
const fileIds = async (t: Indexed) =>
  new Map(
    (
      await t.db.store.pool.query("SELECT path,id FROM files WHERE repository_id=$1", [
        t.c.projectScopeId,
      ])
    ).rows.map((r) => [r.path as string, r.id as string]),
  );
/** Records the statements publish sends through checked-out clients. */
function spyQueries() {
  const statements: { text: string; values: unknown[] }[] = [];
  const original = pg.Client.prototype.query;
  vi.spyOn(pg.Client.prototype, "query").mockImplementation(function (
    this: pg.Client,
    ...args: unknown[]
  ) {
    if (typeof args[0] === "string")
      statements.push({ text: args[0], values: (args[1] as unknown[]) ?? [] });
    return (original as (...a: unknown[]) => unknown).apply(this, args);
  } as typeof original);
  return statements;
}
const payload = (statement: { values: unknown[] }) =>
  JSON.parse(statement.values[1] as string) as { id: string; fileId: string }[];
/** Recomputes the expected graph by cleaning and indexing the same tree from scratch. */
async function fullReindex(t: Indexed) {
  await t.db.store.clean(t.c);
  await t.index.index();
  return graph(t);
}
async function callers(t: Indexed, name: string) {
  const found = (await t.service.execute("search_symbols", { query: name })).results as {
    id: string;
    name: string;
  }[];
  const target = found.find((symbol) => symbol.name === name);
  if (!target) return [];
  return (
    (await t.service.execute("find_callers", { symbolId: target.id })).results as {
      symbol: { name: string };
    }[]
  ).map((r) => r.symbol.name);
}

it("publishes only the edited file's symbols and matches a full reindex", async () => {
  const t = await indexed({
    "a.ts": "export function alpha(){return 1}\nexport function beta(){return 2}\n",
    "b.ts": "import {alpha} from './a';\nexport function useAlpha(){return alpha()}\n",
    "c.ts": "export function gamma(){return 3}\n",
  });
  try {
    const ids = await fileIds(t);
    const statements = spyQueries();
    await writeFile(resolve(t.f.root, "a.ts"), "export function alpha(){return 10}\n");
    expect((await t.index.index()).reason).toMatch(/PROJECT_SEMANTIC_REANALYSIS/);
    vi.restoreAllMocks();
    const inserts = statements.filter((s) => s.text.startsWith("INSERT INTO symbols"));
    const inserted = inserts.flatMap(payload);
    expect(inserted.length).toBeGreaterThan(0);
    expect(new Set(inserted.map((symbol) => symbol.fileId))).toEqual(new Set([ids.get("a.ts")]));
    const remove = statements.find((s) => s.text.startsWith("DELETE FROM symbols"));
    expect(remove?.values[1]).toEqual([ids.get("a.ts")]);
    expect(remove?.values[2]).toEqual(inserted.map((symbol) => symbol.id));
    // The cross-file call from the unaffected b.ts into a.ts survives the narrowed publish.
    expect(await callers(t, "alpha")).toEqual(["useAlpha"]);
    expect(await callers(t, "beta")).toEqual([]);
    const incremental = await graph(t);
    expect(incremental.symbols.map((s) => s.data.name)).not.toContain("beta");
    expect(await fullReindex(t)).toEqual(incremental);
    expect(await callers(t, "alpha")).toEqual(["useAlpha"]);
  } finally {
    await t.dispose();
  }
});

it("removes a deleted file's graph rows and an unaffected file's edge into it", async () => {
  const t = await indexed({
    "a.ts": "export function alpha(){return 1}\n",
    "b.ts": "import {alpha} from './a';\nexport function useAlpha(){return alpha()}\n",
    "c.ts": "export function gamma(){return 3}\n",
    "d.ts": "export function delta(){return 4}\n",
  });
  try {
    const ids = await fileIds(t);
    await unlink(resolve(t.f.root, "a.ts"));
    const result = await t.index.index();
    expect(result.deleted).toBe(1);
    const incremental = await graph(t);
    expect(incremental.symbols.map((s) => s.data.fileId)).not.toContain(ids.get("a.ts"));
    expect(incremental.edges.map((e) => e.data.fileId)).not.toContain(ids.get("a.ts"));
    expect(await callers(t, "alpha")).toEqual([]);
    expect(await fullReindex(t)).toEqual(incremental);
  } finally {
    await t.dispose();
  }
});

it("does not rewrite unchanged file rows when only package.json changes", async () => {
  const t = await indexed({
    "package.json": '{"name":"fixture","version":"1.0.0"}',
    "a.ts": "export function alpha(){return 1}\n",
    "b.ts": "import {alpha} from './a';\nexport function useAlpha(){return alpha()}\n",
  });
  try {
    const versions = async () =>
      (
        await t.db.store.pool.query(
          "SELECT path,xmin::text AS xmin FROM files WHERE repository_id=$1 AND path LIKE '%.ts' ORDER BY path",
          [t.c.projectScopeId],
        )
      ).rows;
    const before = await versions();
    const symbolsBefore = (
      await t.db.store.pool.query("SELECT id,xmin::text FROM symbols ORDER BY id")
    ).rows;
    await writeFile(resolve(t.f.root, "package.json"), '{"name":"fixture","version":"1.0.1"}');
    const result = await t.index.index();
    expect(result.reason).toBe("PARSER_CONFIG_SCHEMA_CHANGED");
    expect(result.changed).toBeGreaterThanOrEqual(2);
    expect(await versions()).toEqual(before);
    expect(
      (await t.db.store.pool.query("SELECT id,xmin::text FROM symbols ORDER BY id")).rows,
    ).toEqual(symbolsBefore);
  } finally {
    await t.dispose();
  }
});

it("publishes an analysis with duplicate unresolved-reference ids", async () => {
  const t = await indexed({ "a.ts": "export function alpha(){return 1}\n" });
  try {
    const store = t.db.store;
    const s = await store.snapshot(t.c);
    const symbol = s.symbols[0]!;
    const duplicate = {
      id: "duplicate-unresolved",
      source: symbol.id,
      fileId: symbol.fileId,
      line: 1,
      expression: "missing",
      reason: "Relation scalar field or referenced field is missing",
      type: "PRISMA_RELATION",
    };
    await publish(store, t.c, {
      ...s,
      unresolved: [...s.unresolved, duplicate, { ...duplicate, line: 2 }],
      version: s.version + 1,
    });
    expect(
      (await store.unresolvedSample(t.c, 100)).results.filter(
        (r: { id: string }) => r.id === duplicate.id,
      ),
    ).toEqual([duplicate]);
  } finally {
    await t.dispose();
  }
});

it("stores edges without foreign keys or a primary key", async () => {
  const t = await indexed({ "a.ts": "export function alpha(){return 1}\n" });
  try {
    const constraints = await t.db.store.pool.query(
      "SELECT contype FROM pg_constraint WHERE conrelid='symbol_edges'::regclass",
    );
    expect(constraints.rows).toEqual([]);
  } finally {
    await t.dispose();
  }
});

it("deletes edges into a removed symbol from an unaffected file, like the former cascade", async () => {
  const t = await indexed({
    "a.ts": "export function alpha(){return 1}\nexport function beta(){return 2}\n",
    "b.ts": "import {alpha} from './a';\nexport function useAlpha(){return alpha()}\n",
  });
  try {
    const store = t.db.store;
    const s = await store.snapshot(t.c);
    const alpha = s.symbols.find((x) => x.qualifiedName === "alpha")!;
    const into = (rows: { target: string }[]) => rows.filter((e) => e.target === alpha.id);
    const bEdges = s.edges.filter((e) => e.fileId !== alpha.fileId);
    expect(into(bEdges)).not.toEqual([]);
    // Snapshot rows come back from jsonb with normalized key order, so republish them once to
    // align the stored per-file digests; afterwards b.ts is unaffected by the edit to a.ts.
    await publish(store, t.c, { ...s, version: s.version + 1 });
    const statements = spyQueries();
    await publish(store, t.c, {
      ...s,
      symbols: s.symbols.filter((x) => x.id !== alpha.id),
      edges: s.edges.filter(
        (e) => e.fileId !== alpha.fileId || (e.source !== alpha.id && e.target !== alpha.id),
      ),
      version: s.version + 2,
    });
    const edgeInserts = statements.filter((q) => q.text.startsWith("INSERT INTO symbol_edges"));
    expect(edgeInserts.flatMap(payload).map((e) => e.fileId)).not.toContain(bEdges[0]!.fileId);
    const stored = (await store.snapshot(t.c)).edges as { source: string; target: string }[];
    expect(into(stored)).toEqual([]);
    expect(stored.filter((e) => e.source === alpha.id)).toEqual([]);
    // b.ts edges that point elsewhere survive.
    expect(stored.some((e) => bEdges.some((b) => b.id === (e as { id?: string }).id))).toBe(true);
  } finally {
    await t.dispose();
  }
});

async function publish(store: PostgresStore, c: ProjectContext, s: Snapshot) {
  const run: IndexResult = {
    version: s.version,
    changed: 0,
    deleted: 0,
    excluded: 0,
    reason: "TEST",
    indexedAt: s.indexedAt,
  };
  await store.locked(c, (locked) => locked.publish(c, s, [], [], run));
}

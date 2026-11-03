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

/** Rows as stored, for restoring a graph that an older release would have written. */
async function rawGraph(t: Indexed) {
  const rows = async (table: string) =>
    (
      await t.db.store.pool.query(`SELECT * FROM ${table} WHERE repository_id=$1`, [
        t.c.projectScopeId,
      ])
    ).rows;
  return {
    files: await rows("files"),
    symbols: await rows("symbols"),
    symbol_edges: await rows("symbol_edges"),
    unresolved_references: await rows("unresolved_references"),
  };
}
const metadataDrift = async (t: Indexed) =>
  (
    await t.db.store.pool.query(
      `SELECT path FROM files WHERE repository_id=$1 AND (hash IS DISTINCT FROM data->>'hash'
         OR file_status IS DISTINCT FROM data->>'status' OR analysis_hash IS DISTINCT FROM data->>'analysisHash')`,
      [t.c.projectScopeId],
    )
  ).rows.map((r) => r.path as string);

it("keeps file metadata columns in step with data written by an alpha.34 publisher", async () => {
  const v1 = "export function alpha(){return 1}\n";
  const v2 = "export function alpha(){return 2}\nexport function beta(){return 3}\n";
  const t = await indexed({
    "a.ts": v1,
    "b.ts": "import {alpha} from './a';\nexport function useAlpha(){return alpha()}\n",
  });
  try {
    const g1 = await graph(t);
    await writeFile(resolve(t.f.root, "a.ts"), v2);
    await t.index.index();
    const v2Rows = await rawGraph(t);
    const g2 = await graph(t);
    await writeFile(resolve(t.f.root, "a.ts"), v1);
    await t.index.index();
    expect(await graph(t)).toEqual(g1);

    // alpha.34 republishes a.ts as v2: its upsert writes only data and path, and it replaces
    // the graph rows itself. The columns must follow data at once.
    const scope = t.c.projectScopeId;
    const a2 = v2Rows.files.find((row) => row.path === "a.ts");
    await t.db.store.pool.query(
      "INSERT INTO files(repository_id,id,path,data) VALUES($1,$2,$3,$4) ON CONFLICT(repository_id,id) DO UPDATE SET data=EXCLUDED.data,path=EXCLUDED.path",
      [scope, a2.id, a2.path, a2.data],
    );
    for (const table of ["symbol_edges", "symbols", "unresolved_references"] as const) {
      await t.db.store.pool.query(`DELETE FROM ${table} WHERE repository_id=$1`, [scope]);
      await t.db.store.pool.query(
        `INSERT INTO ${table} SELECT * FROM jsonb_populate_recordset(NULL::${table},$1::jsonb)`,
        [JSON.stringify(v2Rows[table])],
      );
    }
    expect(await metadataDrift(t)).toEqual([]);
    await writeFile(resolve(t.f.root, "a.ts"), v2);
    expect((await t.index.index()).reason).toBe("UNCHANGED");
    expect(await metadataDrift(t)).toEqual([]);
    expect(await graph(t)).toEqual(g2);

    // Reverting the source must replace the v2 graph, not match stale v1 hashes.
    await writeFile(resolve(t.f.root, "a.ts"), v1);
    expect((await t.index.index()).reason).not.toBe("UNCHANGED");
    expect(await graph(t)).toEqual(g1);
    expect(await metadataDrift(t)).toEqual([]);
    expect((await t.index.index()).reason).toBe("UNCHANGED");
  } finally {
    await t.dispose();
  }
});

it("repairs metadata columns that drifted from data on the next publish of the file", async () => {
  const t = await indexed({
    "a.ts": "export function alpha(){return 1}\n",
    "b.ts": "export function gamma(){return 3}\n",
  });
  try {
    // Without the trigger (as between migrations 10 and 12), stale columns survive a data
    // write; the publish upsert itself must still repair them.
    await t.db.store.pool.query("ALTER TABLE files DISABLE TRIGGER files_metadata_from_data");
    await t.db.store.pool.query(
      "UPDATE files SET hash='stale',analysis_hash='stale' WHERE repository_id=$1 AND path='a.ts'",
      [t.c.projectScopeId],
    );
    expect(await metadataDrift(t)).toEqual(["a.ts"]);
    await t.index.index();
    expect(await metadataDrift(t)).toEqual([]);
    expect((await t.index.index()).reason).toBe("UNCHANGED");
  } finally {
    await t.dispose();
  }
});

/** Captures the structured log events written to stderr. */
function spyLog() {
  const events: Record<string, unknown>[] = [];
  const write = process.stderr.write.bind(process.stderr);
  vi.spyOn(process.stderr, "write").mockImplementation(((chunk: unknown, ...rest: unknown[]) => {
    if (typeof chunk === "string")
      for (const line of chunk.split("\n"))
        try {
          events.push(JSON.parse(line));
        } catch {}
    return (write as (...a: unknown[]) => boolean)(chunk, ...rest);
  }) as typeof process.stderr.write);
  return () => events.filter((e) => e.event === "index_statistics_refreshed");
}

it("refreshes planner statistics only for tables a publish changed substantially", async () => {
  const t = await indexed({
    "a.ts": "export function alpha(){return 1}\n",
    "b.ts": "import {alpha} from './a';\nexport function useAlpha(){return alpha()}\n",
    "c.ts": "export function gamma(){return 3}\n",
    "d.ts": "export function delta(){return 4}\n",
  });
  try {
    await t.db.store.pool.query("ANALYZE files, symbols, symbol_edges, unresolved_references");
    const refreshed = spyLog();
    // One edited file in a 4-file project is far below the shared tables' thresholds.
    await writeFile(resolve(t.f.root, "c.ts"), "export function gamma(){return 30}\n");
    expect((await t.index.index()).reason).toMatch(/PROJECT_SEMANTIC_REANALYSIS/);
    expect(refreshed()).toEqual([]);

    // A bulk publication of more edges than the row floor analyzes only symbol_edges.
    const s = await t.db.store.snapshot(t.c);
    const symbol = s.symbols[0] as { id: string; fileId: string };
    const edges = Array.from({ length: 12000 }, (_, i) => ({
      id: `bulk-${i}`,
      source: symbol.id,
      target: symbol.id,
      fileId: symbol.fileId,
      type: "CALLS",
    }));
    await publish(t.db.store, t.c, {
      ...s,
      version: s.version + 1,
      edges: [...s.edges, ...edges],
    } as Snapshot);
    expect(refreshed()).toEqual([expect.objectContaining({ tables: ["symbol_edges"] })]);
  } finally {
    await t.dispose();
  }
});

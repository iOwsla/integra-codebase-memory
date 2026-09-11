import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodebaseService } from "@codememory/application";
import type { CodeSymbol, IndexReader } from "@codememory/core";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it, vi } from "vitest";

async function indexed(files: Record<string, string>) {
  const db = await testDatabase(),
    f = await fixture(files),
    c = await createProjectContext(f.root);
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

it("queries every indexed tool without loading a snapshot; ranks and pages deterministically", async () => {
  const t = await indexed({
    "a.ts":
      "export function target(){return 1}\nexport function targetExtra(){return target()}\nexport function other(){return target()}\nexport const target_value=2;",
    "b.ts": "import {target} from './a'; export function caller(){return target()}",
    "c.ts": "export const marker='100%_literal\\\\value';\r\nexport const similar='100xxliteral';",
  });
  try {
    const full = await t.db.store.snapshot(t.c),
      id = full.symbols.find((s) => s.name === "target" && s.kind === "FUNCTION")!.id;
    const noSnapshot = vi
      .spyOn(t.db.store, "snapshot")
      .mockRejectedValue(new Error("Unbounded snapshot read"));
    const first = await t.service.execute("search_symbols", { query: "target", limit: 1 });
    expect(first.results).toMatchObject([{ id, score: 100, reason: "exact name" }]);
    expect(first.hasMore).toBe(true);
    const second = await t.service.execute("search_symbols", {
      query: "target",
      limit: 1,
      offset: 1,
    });
    expect(second.results).not.toEqual(first.results);
    expect(
      await t.service.execute("search_symbols", { query: "target", limit: 1, offset: 1 }),
    ).toEqual(second);
    expect(
      (await t.service.execute("search_symbols", { query: "target", kinds: ["CONSTANT"] })).results,
    ).toMatchObject([{ name: "target_value" }]);
    expect(
      (await t.service.execute("search_symbols", { query: "targt", limit: 1 })).results,
    ).toMatchObject([{ reason: "trigram" }]);
    const escaped = await t.service.execute("search_code", { query: "%_literal\\" });
    expect(escaped.results).toEqual([expect.objectContaining({ file: "c.ts", line: 1 })]);
    expect((await t.service.execute("search_symbols", { query: "' OR true --" })).results).toEqual(
      [],
    );
    expect(await t.service.execute("get_symbol", { symbolId: id })).toMatchObject({
      symbol: { id },
      snippet: "export function target(){return 1}",
      incoming: expect.any(Number),
    });
    const callers = await t.service.execute("find_callers", { symbolId: id, limit: 1 });
    expect(callers).toMatchObject({
      hasMore: true,
      nextOffset: 1,
      results: [{ type: "CALLS", target: id }],
    });
    expect(
      (await t.service.execute("find_callers", { symbolId: id, limit: 1, offset: 1 })).results,
    ).not.toEqual(callers.results);
    const caller = full.symbols.find((s) => s.name === "caller")!.id;
    expect((await t.service.execute("find_callees", { symbolId: caller })).results).toMatchObject([
      { target: id },
    ]);
    expect((await t.service.execute("find_references", { symbolId: id })).results).not.toEqual([]);
    expect(
      (
        await t.service.execute("trace_dependencies", {
          fromSymbolId: caller,
          edgeTypes: ["CALLS"],
        })
      ).paths,
    ).toEqual([[caller, id]]);
    expect((await t.service.execute("get_file_outline", { path: "a.ts", limit: 1 })).hasMore).toBe(
      true,
    );
    expect(
      await t.service.execute("get_file_context", { path: "c.ts", line: 2, before: 0, after: 0 }),
    ).toMatchObject({ startLine: 2, endLine: 2, content: "export const similar='100xxliteral';" });
    await expect(
      t.service.execute("get_file_context", { path: "c.ts", line: 999 }),
    ).rejects.toMatchObject({ code: "INVALID_RANGE" });
    await expect(
      t.service.execute("search_symbols", { query: "target", limit: 101 }),
    ).rejects.toBeDefined();
    expect(noSnapshot).not.toHaveBeenCalled();
    noSnapshot.mockRestore();
  } finally {
    await t.dispose();
  }
});

it("pins results and metadata to one generation during concurrent publication and closes readers", async () => {
  const t = await indexed({ "a.ts": "export function before(){return 1}" });
  let retained: IndexReader | undefined;
  try {
    const initial = await t.db.store.snapshot(t.c);
    await t.db.store.readIndex(t.c, async (reader, metadata) => {
      retained = reader;
      await writeFile(resolve(t.f.root, "a.ts"), "export function after(){return 2}");
      await t.index.index();
      expect(metadata.indexVersion).toBe(initial.version);
      expect(
        (await reader.searchSymbols("before", [], { limit: 20, offset: 0 })).results,
      ).toMatchObject([{ name: "before" }]);
      expect((await reader.searchSymbols("after", [], { limit: 20, offset: 0 })).results).toEqual(
        [],
      );
    });
    expect(await t.service.execute("search_symbols", { query: "after" })).toMatchObject({
      indexVersion: initial.version + 1,
      results: [{ name: "after" }],
    });
    await expect(retained!.searchCode("before", { limit: 1, offset: 0 })).rejects.toMatchObject({
      code: "READER_CLOSED",
    });
    await expect(
      t.db.store.readIndex(t.c, async () => {
        throw new Error("callback failure");
      }),
    ).rejects.toThrow("callback failure");
    expect((await t.service.execute("search_symbols", { query: "after" })).results).toHaveLength(1);
  } finally {
    await t.dispose();
  }
});

it("bounds ambiguous symbol candidates and refuses foreign IDs and paths for every graph direction", async () => {
  const t = await indexed(
    Object.fromEntries(
      Array.from({ length: 25 }, (_, i) => [`f${i}.ts`, `export function shared(){return ${i}}`]),
    ),
  );
  const foreign = await fixture({ "secret.ts": "export function secret(){return 42}" });
  try {
    const other = await createProjectContext(foreign.root);
    await t.db.store.register(other);
    await new IndexService(
      other,
      t.db.store,
      new RepositoryScanner(),
      new TypeScriptPlugin(),
    ).index();
    const id = (await t.db.store.snapshot(other)).symbols.find((s) => s.name === "secret")!.id;
    for (const name of ["get_symbol", "find_callers", "find_callees", "find_references"] as const)
      await expect(t.service.execute(name, { symbolId: id })).rejects.toMatchObject({
        code: "NOT_FOUND",
      });
    await expect(
      t.service.execute("trace_dependencies", { fromSymbolId: id }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await t.service.execute("search_code", { query: "return 42" })).results).toEqual([]);
    await expect(
      t.service.execute("get_file_outline", { path: resolve(foreign.root, "secret.ts") }),
    ).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
    try {
      await t.service.execute("get_symbol", { name: "shared" });
      throw new Error("Expected ambiguity");
    } catch (error) {
      expect(error).toMatchObject({ code: "AMBIGUOUS_SYMBOL" });
      expect(JSON.parse((error as Error).message)).toHaveLength(20);
    }
    const all: CodeSymbol[] = [];
    for (let offset = 0; offset < 25; offset += 7) {
      const page = await t.service.execute("search_symbols", { query: "shared", limit: 7, offset });
      all.push(...(page.results as CodeSymbol[]));
      expect(page.hasMore).toBe(offset + 7 < 25);
    }
    expect(new Set(all.map((s) => s.id)).size).toBe(25);
  } finally {
    await foreign.dispose();
    await t.dispose();
  }
});

it("bounds wide traversals, deduplicates call sites and stops cycles in both directions", async () => {
  const leaves = Array.from({ length: 1100 }, (_, i) => `export function leaf${i}(){}`);
  const t = await indexed({
    "graph.ts": `${leaves.join("\n")}\nexport function hub(){${leaves.map((_, i) => `leaf${i}();`).join("")}}\nexport function a(){b();b()}\nexport function b(){a()}`,
  });
  try {
    const snap = await t.db.store.snapshot(t.c),
      id = (name: string) => snap.symbols.find((s) => s.name === name)!.id;
    const result = await t.service.execute("trace_dependencies", {
      fromSymbolId: id("hub"),
      maxPaths: 100,
      edgeTypes: ["CALLS"],
    });
    expect(result.truncated).toBe(true);
    expect(result.paths).toHaveLength(100);
    for (const direction of ["incoming", "outgoing"] as const) {
      const cycle = await t.service.execute("trace_dependencies", {
        fromSymbolId: id("a"),
        direction,
        edgeTypes: ["CALLS"],
      });
      expect(cycle).toMatchObject({ paths: [[id("a"), id("b")]], truncated: false });
    }
    expect(
      await t.service.execute("trace_dependencies", {
        fromSymbolId: id("a"),
        edgeTypes: ["EXTENDS"],
      }),
    ).toMatchObject({ paths: [[id("a")]], truncated: false });
  } finally {
    await t.dispose();
  }
});

it("upgrades migration 1 without rewriting indexed data and applies migration 2 only once", async () => {
  const t = await indexed({ "a.ts": "export const kept=1" });
  try {
    const before = await t.db.store.pool.query("SELECT id,xmin::text FROM symbols ORDER BY id");
    await t.db.store.pool.query(
      "DROP INDEX symbols_name_lower,symbols_qualified_lower,files_content_lower,files_incomplete,index_runs_project_latest,edges_in_page,edges_out_page; DELETE FROM schema_migrations WHERE version=2",
    );
    await t.db.store.migrate();
    await t.db.store.migrate();
    expect(
      (await t.db.store.pool.query("SELECT id,xmin::text FROM symbols ORDER BY id")).rows,
    ).toEqual(before.rows);
    expect((await t.db.store.diagnostics()).migrations).toEqual([{ version: 1 }, { version: 2 }]);
    expect((await t.service.execute("search_symbols", { query: "kept" })).results).toHaveLength(1);
  } finally {
    await t.dispose();
  }
});

it("applies generated penalties and returns short lexical/context snippets", async () => {
  const t = await indexed({
    "a.ts": "export function exact(){return 1}",
    "b.ts": "export function exact(){return 2}",
    "long.ts": `export const text='${"x".repeat(15000)}';`,
  });
  try {
    await t.db.store.pool.query(
      "UPDATE files SET data=jsonb_set(data,'{generated}','true') WHERE repository_id=$1 AND path='a.ts'",
      [t.c.projectScopeId],
    );
    const result = await t.service.execute("search_symbols", { query: "exact" });
    expect(result.results).toMatchObject([
      { file: "b.ts", score: 100 },
      { file: "a.ts", score: 50, reason: "exact name; generated penalty" },
    ]);
    const lexical = await t.service.execute("search_code", { query: "xxxxx", limit: 1 });
    expect((lexical.results as { snippet: string }[])[0]!.snippet.length).toBe(500);
    expect(
      String((await t.service.execute("get_file_context", { path: "long.ts", line: 1 })).content)
        .length,
    ).toBe(12000);
    await t.db.store.pool.query(
      "UPDATE files SET data=jsonb_set(data,'{status}','\"SKIPPED_TOO_LARGE\"') WHERE repository_id=$1 AND path='long.ts'",
      [t.c.projectScopeId],
    );
    expect(await t.service.execute("search_code", { query: "xxxxx" })).toMatchObject({
      results: [],
      incomplete: true,
    });
  } finally {
    await t.dispose();
  }
});

it("times out blocked reads with a domain error and releases the transaction", async () => {
  const t = await indexed({ "a.ts": "export const available=1" });
  const blocker = await t.db.store.pool.connect();
  try {
    await blocker.query("BEGIN");
    await blocker.query("LOCK TABLE symbols IN ACCESS EXCLUSIVE MODE");
    await expect(t.service.execute("search_symbols", { query: "available" })).rejects.toMatchObject(
      { code: "QUERY_TIMEOUT" },
    );
    await blocker.query("ROLLBACK");
    expect(
      (await t.service.execute("search_symbols", { query: "available" })).results,
    ).toHaveLength(1);
  } finally {
    await blocker.query("ROLLBACK");
    blocker.release();
    await t.dispose();
  }
});

import { CodebaseService } from "@codememory/application";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import pg from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { PostgresIndexReader } from "../../packages/database/src/reader";

let db: Awaited<ReturnType<typeof testDatabase>>;
let client: pg.Client;
const reader = (scope: string) =>
  new PostgresIndexReader(client as unknown as pg.PoolClient, scope);

const insertJson = (sql: string, rows: unknown[]) => client.query(sql, [JSON.stringify(rows)]);
async function repository(id: string) {
  await client.query("INSERT INTO repositories(id,root,name,version) VALUES($1,$2,$1,1)", [
    id,
    `/synthetic/${id}`,
  ]);
}
async function files(
  repo: string,
  rows: { id: string; path: string; status?: string; generated?: boolean; content: string }[],
) {
  await insertJson(
    `INSERT INTO files(repository_id,id,path,data)
     SELECT '${repo}', j->>'id', j->>'path', j - 'id' - 'path' FROM jsonb_array_elements($1::jsonb) j`,
    rows.map((r) => ({ status: "INDEXED", generated: false, ...r })),
  );
}
async function symbols(
  repo: string,
  rows: {
    id: string;
    fileId: string;
    file: string;
    name: string;
    kind: string;
    startLine?: number;
    exported?: boolean;
  }[],
) {
  await insertJson(
    `INSERT INTO symbols(repository_id,id,file_id,name,qualified_name,data)
     SELECT '${repo}', j->>'id', j->>'fileId', j->>'name', j->>'name', j FROM jsonb_array_elements($1::jsonb) j`,
    rows.map((r) => ({ startLine: 1, endLine: 1, exported: false, metadata: {}, ...r })),
  );
}
async function edges(repo: string, rows: [string, string, string][]) {
  await insertJson(
    `INSERT INTO symbol_edges(repository_id,id,source_id,target_id,file_id,edge_type,data)
     SELECT '${repo}', j->>0||'>'||(j->>1)||':'||(j->>2), j->>0, j->>1, 'f', j->>2, '{}'::jsonb
     FROM jsonb_array_elements($1::jsonb) j`,
    rows,
  );
}

/** search_code as released before streaming batches: one statement that splits every
 * matching file before ORDER BY/OFFSET. Kept here as the result-equality fixture. */
async function legacySearchCode(scope: string, query: string, limit: number, offset: number) {
  const pattern = `%${query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
  const rows = (
    await client.query(
      `
      SELECT f.path AS file, l.ordinality::int AS line, left(l.text,500) AS snippet,
             CASE WHEN f.data->>'generated'='true' THEN 0.5 ELSE 1 END::float8 AS score, 'lexical substring' AS reason
      FROM files f CROSS JOIN LATERAL regexp_split_to_table(f.data->>'content', E'\\r?\\n') WITH ORDINALITY AS l(text,ordinality)
      WHERE f.repository_id=$1 AND f.data->>'status'='INDEXED'
        AND lower(f.data->>'content') LIKE $2 AND lower(l.text) LIKE $2
      ORDER BY f.path COLLATE "C", l.ordinality LIMIT $3 OFFSET $4`,
      [scope, pattern, limit + 1, offset],
    )
  ).rows;
  return {
    results: rows.slice(0, limit),
    hasMore: rows.length > limit,
    nextOffset: offset + limit,
  };
}

/** trace_dependencies as released before level batching (one query per node). */
async function legacyTrace(
  scope: string,
  from: string,
  direction: "incoming" | "outgoing",
  maxDepth: number,
  maxPaths: number,
  types: string[],
) {
  const anchor = direction === "incoming" ? "target_id" : "source_id";
  const neighbor = direction === "incoming" ? "source_id" : "target_id";
  const paths: string[][] = [],
    queue: string[][] = [[from]],
    adjacency = new Map<string, string[]>();
  let truncated = false,
    steps = 0,
    fetched = 0;
  while (queue.length && paths.length < maxPaths && steps++ < 10000) {
    const path = queue.shift() as string[],
      last = path[path.length - 1] as string;
    if (path.length > maxDepth) {
      paths.push(path);
      continue;
    }
    let next = adjacency.get(last);
    if (!next) {
      if (adjacency.size >= 128 || fetched >= 10000) {
        truncated = true;
        break;
      }
      const limit = Math.min(1000, 10000 - fetched);
      const rows = (
        await client.query<{ id: string }>(
          `SELECT DISTINCT ${neighbor} COLLATE "C" AS id FROM symbol_edges WHERE repository_id=$1 AND ${anchor}=$2 AND (cardinality($3::text[])=0 OR edge_type=ANY($3)) ORDER BY id LIMIT $4`,
          [scope, last, types, limit + 1],
        )
      ).rows;
      if (rows.length > limit) truncated = true;
      next = rows.slice(0, limit).map((r) => r.id);
      fetched += next.length;
      adjacency.set(last, next);
    }
    const available = next.filter((n) => !path.includes(n));
    if (!available.length) {
      paths.push(path);
      continue;
    }
    for (const id of available) {
      if (queue.length >= 1000) {
        truncated = true;
        break;
      }
      queue.push([...path, id]);
    }
  }
  return { paths, truncated: truncated || queue.length > 0 };
}

beforeAll(async () => {
  db = await testDatabase();
  client = new pg.Client(db.url);
  await client.connect();
  await client.query("SET pg_trgm.similarity_threshold = 0.3");
});
afterAll(async () => {
  await client?.end();
  await db?.dispose();
});

describe("search_code streaming", () => {
  beforeAll(async () => {
    await repository("code");
    const rows = [];
    for (let i = 0; i < 3000; i++) {
      const eol = i % 3 === 0 ? "\r\n" : "\n";
      const lines = [
        `// file ${i}`,
        i % 7 === 0 ? "const nothing = 1;" : `export function create${i}() {}`,
        "  return value;",
        i % 4 === 0 ? `  CreateThing(${i}); createAgain();` : "  noop();",
        i % 97 === 0 ? `const long = "create${"x".repeat(700)}";` : "",
        i % 500 === 0 ? "literal zebra_%x marker" : "",
        // A lone CR does not end a line: "create\r" then matches LF files line by line,
        // while CRLF files match only as whole content and contribute no lines.
        i % 3 === 0 ? "lone create" : "lone create\rafter",
      ];
      // A last line without a trailing newline still matches and is numbered.
      const tail = i % 5 === 0 ? `${eol}const tail = create();` : eol;
      const dir = i % 17 === 0 ? "Lib" : i % 19 === 0 ? "src_x" : `src/m${i % 41}`;
      rows.push({
        id: `f${i}`,
        path: `${dir}/file${i}.ts`,
        status: i % 13 === 0 ? "FAILED" : "INDEXED",
        generated: i % 11 === 0,
        content: lines.join(eol) + tail,
      });
    }
    await files("code", rows);
    await client.query("ANALYZE files");
  });

  it("returns the same pages as the single-statement implementation", async () => {
    const cases: [string, number, number][] = [
      ["create", 20, 0],
      ["create", 20, 20],
      ["create", 20, 200],
      ["create", 100, 4321],
      ["CREATE", 7, 9000],
      ["create", 20, 100000],
      ["zebra_%x", 20, 0],
      ["zebraa%x", 20, 0],
      ["tail = create()", 50, 30],
      ["absent-term", 20, 0],
      ["create\r", 20, 1500],
      ["\r", 50, 2500],
    ];
    for (const [query, limit, offset] of cases) {
      const actual = await reader("code").searchCode(query, { limit, offset });
      expect(actual, `${query} ${limit}/${offset}`).toEqual(
        await legacySearchCode("code", query, limit, offset),
      );
    }
    const spy = vi.spyOn(client, "query");
    try {
      // Content-only matches leave the first batch short, so later batches continue
      // from the path cursor with the remaining offset.
      const page = await reader("code").searchCode("create\r", { limit: 20, offset: 1500 });
      expect(page.results).toHaveLength(20);
      expect(spy.mock.calls.length).toBeGreaterThan(1);
    } finally {
      spy.mockRestore();
    }
    const first = await reader("code").searchCode("create", { limit: 20, offset: 0 });
    expect(first.results).toHaveLength(20);
    expect(first.hasMore).toBe(true);
  });

  it("keeps CRLF numbering, a final line without newline and 500-character snippets", async () => {
    const page = await reader("code").searchCode("tail = create()", { limit: 3, offset: 0 });
    const legacy = await legacySearchCode("code", "tail = create()", 3, 0);
    expect(page).toEqual(legacy);
    const row = page.results[0] as { file: string; line: number; snippet: string };
    expect(row.snippet).toBe("const tail = create();");
    expect(row.line).toBe(8);
    const long = await reader("code").searchCode('"createxxx', { limit: 5, offset: 0 });
    expect((long.results[0] as { snippet: string }).snippet).toHaveLength(500);
    expect(long).toEqual(await legacySearchCode("code", '"createxxx', 5, 0));
  });
});

describe("search_symbols ties", () => {
  it("ranks source definitions before test and member matches with equal scores", async () => {
    await repository("sym");
    await files("sym", [
      { id: "dto", path: "src/a/dto.ts", content: "" },
      { id: "svc", path: "src/z/service.ts", content: "" },
      { id: "spec", path: "tests/a.test.ts", content: "" },
      { id: "gen", path: "gen/client.ts", generated: true, content: "" },
    ]);
    await symbols("sym", [
      { id: "p", fileId: "dto", file: "src/a/dto.ts", name: "create", kind: "PROPERTY" },
      {
        id: "m",
        fileId: "svc",
        file: "src/z/service.ts",
        name: "create",
        kind: "METHOD",
        exported: true,
      },
      { id: "t", fileId: "spec", file: "tests/a.test.ts", name: "create", kind: "FUNCTION" },
      {
        id: "c",
        fileId: "svc",
        file: "src/z/service.ts",
        name: "Create",
        kind: "CLASS",
        startLine: 9,
      },
      { id: "g", fileId: "gen", file: "gen/client.ts", name: "create", kind: "FUNCTION" },
    ]);
    const page = await reader("sym").searchSymbols("create", [], { limit: 20, offset: 0 });
    expect(page.results.map((s) => [s.id, s.score, s.reason])).toEqual([
      ["c", 100, "exact name"],
      ["m", 100, "exact name"],
      ["p", 100, "exact name"],
      ["t", 100, "exact name"],
      ["g", 50, "exact name; generated penalty"],
    ]);
  });
});

describe("quality report metadata", () => {
  it("reads the published unresolved total and falls back to counting rows", async () => {
    await repository("quality");
    await client.query(
      "INSERT INTO unresolved_references(repository_id,id,data) SELECT 'quality', 'u'||g, '{}' FROM generate_series(1,3) g",
    );
    expect(
      (await reader("quality").deadCodeCandidates({ limit: 5, offset: 0 })).unresolvedReferences,
    ).toBe(3);
    await client.query(
      `INSERT INTO index_runs(repository_id,data) VALUES('quality','{"totals":{"unresolvedReferences":2}}'),
        ('quality','{"totals":{"unresolvedReferences":7}}')`,
    );
    const dead = await reader("quality").deadCodeCandidates({ limit: 5, offset: 0 });
    const duplicate = await reader("quality").duplicateCode(20, { limit: 5, offset: 0 });
    expect(dead.unresolvedReferences).toBe(7);
    expect(duplicate.unresolvedReferences).toBe(7);
  });

  it("matches status totals for an indexed project and separates structural edges", async () => {
    const f = await fixture({
      "a.ts":
        "export function exportedUnused(){return 1}\nexport function called(){return 2}\nfunction caller(){return called()}\ncaller();\nmissing.call();",
    });
    try {
      const context = await createProjectContext(f.root);
      await db.store.register(context);
      await new IndexService(
        context,
        db.store,
        new RepositoryScanner(),
        new TypeScriptPlugin(),
      ).index();
      const service = new CodebaseService(context, db.store);
      const status = await db.store.status(context);
      const dead = await service.execute("find_dead_code_candidates", {});
      expect(status.unresolvedReferences).toBeGreaterThan(0);
      expect(dead.unresolvedReferences).toBe(status.unresolvedReferences);
      const unused = (await service.execute("get_symbol", { name: "exportedUnused" })) as Record<
        string,
        unknown
      >;
      expect(unused).toMatchObject({ usageIncoming: 0, incomingByType: { DECLARES: 1 } });
      expect(unused.incoming).toBe(
        Object.values(unused.incomingByType as Record<string, number>).reduce((a, b) => a + b, 0),
      );
      expect(unused.incoming).toBeGreaterThan(0);
      const called = (await service.execute("get_symbol", { name: "called" })) as Record<
        string,
        unknown
      >;
      expect(called.usageIncoming).toBeGreaterThanOrEqual(1);
      expect(called.incomingByType).toMatchObject({ CALLS: 1, DECLARES: 1 });
      const caller = (await service.execute("get_symbol", { name: "caller" })) as Record<
        string,
        unknown
      >;
      expect(caller.outgoingByType).toMatchObject({ CALLS: 1 });
      expect(caller.outgoing).toBe(
        Object.values(caller.outgoingByType as Record<string, number>).reduce((a, b) => a + b, 0),
      );
    } finally {
      await f.dispose();
    }
  });
});

describe("trace_dependencies batching", () => {
  beforeAll(async () => {
    await repository("graph");
    await files("graph", [{ id: "f", path: "graph.ts", content: "" }]);
    const nodes = ["n"];
    const links: [string, string, string][] = [];
    for (let level = 0, frontier = ["n"]; level < 3; level++) {
      const next: string[] = [];
      for (const parent of frontier)
        for (let i = 0; i < 10; i++) {
          const child = `${parent}.${i}`;
          nodes.push(child);
          next.push(child);
          links.push([parent, child, i % 3 === 0 ? "REFERENCES" : "CALLS"]);
        }
      frontier = next;
    }
    // Back edges, a duplicate neighbour via a second type and a hub over the per-source cap.
    links.push(["n.1.1", "n", "CALLS"], ["n.2", "n.1", "CALLS"], ["n.2", "n.1", "REFERENCES"]);
    nodes.push("hub");
    for (let i = 0; i < 1200; i++) {
      nodes.push(`h${i}`);
      links.push(["hub", `h${i}`, "CALLS"]);
      if (i < 20) links.push([`h${i}`, `h${i + 1}`, "CALLS"]);
    }
    await symbols(
      "graph",
      nodes.map((id) => ({ id, fileId: "f", file: "graph.ts", name: id, kind: "FUNCTION" })),
    );
    await edges("graph", links);
  });

  it("returns the same paths and truncation as per-node adjacency reads", async () => {
    const cases: [string, "incoming" | "outgoing", number, number, string[]][] = [
      ["n", "outgoing", 3, 100, []],
      ["n", "outgoing", 2, 100, []],
      ["n", "outgoing", 4, 100, []],
      ["n", "outgoing", 10, 100, ["CALLS"]],
      ["n", "outgoing", 3, 7, ["REFERENCES"]],
      ["n.1.1.1", "incoming", 10, 100, []],
      ["n.1", "incoming", 5, 100, ["CALLS"]],
      ["hub", "outgoing", 1, 100, []],
      ["hub", "outgoing", 3, 100, []],
      ["h0", "outgoing", 10, 100, []],
    ];
    for (const [from, direction, depth, maxPaths, types] of cases)
      expect(
        await reader("graph").trace(from, direction, depth, maxPaths, types),
        `${from} ${direction} ${depth}/${maxPaths} ${types}`,
      ).toEqual(await legacyTrace("graph", from, direction, depth, maxPaths, types));
  });

  it("issues one adjacency query per depth level", async () => {
    const spy = vi.spyOn(client, "query");
    try {
      const result = await reader("graph").trace("n", "outgoing", 3, 100, []);
      expect(result.paths).toHaveLength(100);
      expect(spy.mock.calls.length).toBeLessThanOrEqual(3 + 2);
    } finally {
      spy.mockRestore();
    }
  });
});

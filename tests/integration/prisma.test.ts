import { unlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodebaseService } from "@codememory/application";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it } from "vitest";

it("queries paginated Prisma usages, persists metadata and replaces deleted/renamed source", async () => {
  const db = await testDatabase(),
    f = await fixture({
      "schema.prisma":
        'generator client {\n provider = "prisma-client-js"\n}\nmodel User {\n id Int @id\n}\n',
      "db.ts":
        "import {PrismaClient} from '@prisma/client';export const client=new PrismaClient();export const user=client.user;",
      "a.ts": "import {user} from './db';export function first(){return user.findMany()}",
      "b.ts": "import {user as users} from './db';export function second(){return users.count()}",
    });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const index = new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin());
    await index.index();
    const service = new CodebaseService(c, db.store);
    const models = await service.execute("search_symbols", { query: "User", kinds: ["MODEL"] });
    const model = (models.results as { id: string }[])[0]!;
    const page = await service.execute("find_references", { symbolId: model.id, limit: 1 });
    expect(page.results).toMatchObject([
      { metadata: { operation: "findMany" }, symbol: { name: "first", file: "a.ts" } },
    ]);
    expect(page.hasMore).toBe(true);
    const next = await service.execute("find_references", {
      symbolId: model.id,
      limit: 1,
      offset: page.nextOffset,
    });
    expect(next.results).toMatchObject([
      { metadata: { operation: "count" }, symbol: { name: "second", file: "b.ts" } },
    ]);
    expect(next.hasMore).toBe(false);
    expect((await service.execute("get_symbol", { symbolId: model.id })).snippet).toContain(
      "model User",
    );
    await unlink(resolve(f.root, "a.ts"));
    await writeFile(
      resolve(f.root, "b.ts"),
      "import {user} from './db';export function renamed(){return user.findFirst()}",
    );
    await index.index();
    const changed = await service.execute("find_references", { symbolId: model.id });
    expect(changed.results).toMatchObject([
      { metadata: { operation: "findFirst" }, symbol: { name: "renamed" } },
    ]);
    expect(changed.results).toHaveLength(1);
    await writeFile(resolve(f.root, "schema.prisma"), "model Broken {\n ??\n}\n");
    await index.index();
    const status = await service.status();
    expect(status.incomplete).toBe(true);
    expect(
      (await service.execute("search_symbols", { query: "User", kinds: ["MODEL"] })).results,
    ).toEqual([]);
  } finally {
    await db.dispose();
    await f.dispose();
  }
});
it("uses physical PostgreSQL relationship indexes for selective model-usage lookup", async () => {
  const db = await testDatabase(),
    f = await fixture({ "main.ts": "export const marker=1" });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    await new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin()).index();
    const file = (
      await db.store.pool.query("SELECT id FROM files WHERE repository_id=$1", [c.projectScopeId])
    ).rows[0].id;
    await db.store.pool.query(
      `INSERT INTO symbols(repository_id,id,file_id,name,qualified_name,data)
   SELECT $1,'bulk-'||n,$2,'n'||n,'n'||n,jsonb_build_object('id','bulk-'||n,'file','bulk.ts','startLine',n)
   FROM generate_series(1,10000) n`,
      [c.projectScopeId, file],
    );
    await db.store.pool.query(
      `INSERT INTO symbol_edges(repository_id,id,source_id,target_id,file_id,edge_type,data)
   SELECT $1,'edge-'||n,'bulk-'||n,'bulk-'||n,$2,'REFERENCES',jsonb_build_object('line',n)
   FROM generate_series(1,10000) n`,
      [c.projectScopeId, file],
    );
    await db.store.pool.query("ANALYZE symbol_edges");
    await db.store.pool.query("ANALYZE symbols");
    const explained = await db.store.pool.query(
      `EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON)
   SELECT e.data,s.data AS symbol FROM symbol_edges e JOIN symbols s ON s.repository_id=e.repository_id AND s.id=e.source_id
   WHERE e.repository_id=$1 AND e.target_id=$2 AND e.edge_type=$3
   ORDER BY s.data->>'file' COLLATE "C",(e.data->>'line')::int,e.id COLLATE "C" LIMIT 41`,
      [c.projectScopeId, "bulk-5000", "REFERENCES"],
    );
    const plan = JSON.stringify(explained.rows[0]);
    expect(plan).toMatch(/edges_in(?:_page)?/);
    expect(
      (
        await db.store.pool.query("SELECT indexname FROM pg_indexes WHERE tablename='symbol_edges'")
      ).rows.map((r) => r.indexname),
    ).toContain("edges_in_page");
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

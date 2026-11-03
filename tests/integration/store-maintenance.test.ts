import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { IndexResult, ProjectContext, Snapshot } from "@codememory/core";
import { PostgresStore } from "@codememory/database";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import pg from "pg";
import { expect, it } from "vitest";

async function project(db: Awaited<ReturnType<typeof testDatabase>>, source: string) {
  const f = await fixture({
    "a.ts": source,
    "b.ts": "import {alpha} from './a';\nexport function useAlpha(){return alpha()}\n",
  });
  const c = await createProjectContext(f.root);
  await db.store.register(c);
  const index = new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin());
  await index.index();
  return { f, c, index };
}
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
const count = async (db: PostgresStore, table: string, c: ProjectContext) =>
  (
    await db.pool.query(`SELECT count(*)::int AS n FROM ${table} WHERE repository_id=$1`, [
      c.projectScopeId,
    ])
  ).rows[0].n as number;

it("keeps the latest 20 index runs and prunes month-old index errors", async () => {
  const db = await testDatabase();
  const p = await project(db, "export function alpha(){return 1}\n");
  try {
    const s = await db.store.snapshot(p.c);
    for (let version = s.version + 1; version <= s.version + 25; version++)
      await publish(db.store, p.c, { ...s, version });
    expect(await count(db.store, "index_runs", p.c)).toBe(20);
    expect((await db.store.status(p.c)).version).toBe(s.version + 25);
    await db.store.pool.query(
      "INSERT INTO index_errors(repository_id,message,created_at) VALUES($1,'old',now()-interval '31 days'),($1,'recent',now()-interval '1 day')",
      [p.c.projectScopeId],
    );
    await db.store.recordFailure(p.c, "latest");
    expect(
      (
        await db.store.pool.query(
          "SELECT message FROM index_errors WHERE repository_id=$1 ORDER BY id",
          [p.c.projectScopeId],
        )
      ).rows.map((r) => r.message),
    ).toEqual(["recent", "latest"]);
  } finally {
    await db.dispose();
    await p.f.dispose();
  }
});

it("cleans a large project set-wise under a low statement timeout and keeps versions monotonic", async () => {
  const db = await testDatabase();
  const target = await project(db, "export function alpha(){return 1}\n");
  const other = await project(db, "export function alpha(){return 2}\n");
  const strict = new PostgresStore(
    undefined,
    undefined,
    new pg.Pool({ connectionString: db.url, max: 2, statement_timeout: 300 }),
  );
  try {
    const file = (
      await db.store.pool.query("SELECT id FROM files WHERE repository_id=$1 LIMIT 1", [
        target.c.projectScopeId,
      ])
    ).rows[0].id;
    // Enough rows that a per-row FK cascade from files would exceed the 300 ms budget.
    await db.store.pool.query(
      `INSERT INTO symbols(repository_id,id,file_id,name,qualified_name,data)
       SELECT $1,'bulk-'||n,$2,'n'||n,'n'||n,jsonb_build_object('id','bulk-'||n) FROM generate_series(1,60000) n`,
      [target.c.projectScopeId, file],
    );
    await db.store.pool.query(
      `INSERT INTO symbol_edges(repository_id,id,source_id,target_id,file_id,edge_type,data)
       SELECT $1,'edge-'||n,'bulk-'||n,'bulk-'||(n%60000+1),$2,'CALLS','{}' FROM generate_series(1,60000) n`,
      [target.c.projectScopeId, file],
    );
    const before = (await db.store.status(target.c)).version as number;
    const otherBefore = await Promise.all(
      ["files", "symbols", "symbol_edges", "index_runs", "index_jobs"].map((table) =>
        count(db.store, table, other.c),
      ),
    );
    await strict.clean(target.c);
    for (const table of [
      "files",
      "symbols",
      "symbol_edges",
      "unresolved_references",
      "index_runs",
      "index_jobs",
    ])
      expect(await count(db.store, table, target.c)).toBe(0);
    expect(
      await Promise.all(
        ["files", "symbols", "symbol_edges", "index_runs", "index_jobs"].map((table) =>
          count(db.store, table, other.c),
        ),
      ),
    ).toEqual(otherBefore);
    expect(await db.store.status(target.c)).toMatchObject({
      version: 0,
      symbols: 0,
      edges: 0,
      freshness: "NOT_READY",
      lastIndexJob: null,
    });
    await expect(db.store.readIndex(target.c, async () => 1)).rejects.toMatchObject({
      code: "INDEX_NOT_READY",
    });
    const reindexed = await target.index.index();
    expect(reindexed.reason).toBe("INITIAL");
    expect(reindexed.version).toBeGreaterThan(before);
    expect((await db.store.status(target.c)).version).toBe(reindexed.version);
    // Removing deletes the project's rows set-wise too, under the same strict pool.
    await strict.clean(target.c, true);
    expect(
      (await db.store.pool.query("SELECT id FROM repositories ORDER BY id")).rows.map((r) => r.id),
    ).toEqual([other.c.projectScopeId]);
  } finally {
    await strict.pool.end();
    await db.dispose();
    await target.f.dispose();
    await other.f.dispose();
  }
});

it("reports a RUNNING job without a live lock as interrupted, not updating", async () => {
  const db = await testDatabase();
  const p = await project(db, "export function alpha(){return 1}\n");
  const metadata = () => db.store.readIndex(p.c, async (_reader, m) => m);
  try {
    await db.store.pool.query(
      `UPDATE index_jobs SET backend_pid=pg_backend_pid(),data=data||'{"state":"RUNNING","stage":"ANALYZING"}' WHERE repository_id=$1`,
      [p.c.projectScopeId],
    );
    expect(await metadata()).toMatchObject({ freshness: "LAST_COMPLETED", incomplete: false });
    expect(await metadata()).not.toHaveProperty("staleSince");
    expect(await db.store.status(p.c)).toMatchObject({
      freshness: "LAST_COMPLETED",
      incomplete: false,
      lastIndexJob: { state: "RUNNING", lockActive: false, interrupted: true },
    });
    // While the recorded backend holds the project lock, the job is still reported as updating.
    await db.store.locked(p.c, async () => {
      await db.store.pool.query(
        // pg_locks spans the whole cluster: match this database and this project's lock key.
        `UPDATE index_jobs SET backend_pid=(SELECT pid FROM pg_locks WHERE locktype='advisory' AND granted
          AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND objsubid=1
          AND classid::bigint=((hashtextextended($1,0)>>32)&4294967295)
          AND objid::bigint=(hashtextextended($1,0)&4294967295)) WHERE repository_id=$1`,
        [p.c.projectScopeId],
      );
      expect(await metadata()).toMatchObject({ freshness: "UPDATING", incomplete: true });
      expect(await db.store.status(p.c)).toMatchObject({
        freshness: "UPDATING",
        lastIndexJob: { lockActive: true, interrupted: false },
      });
    });
  } finally {
    await db.dispose();
    await p.f.dispose();
  }
});

it("rejects a query whose backend is terminated and keeps serving afterwards", async () => {
  const db = await testDatabase();
  const p = await project(db, "export function alpha(){return 1}\n");
  const admin = new pg.Client({ connectionString: db.url });
  await admin.connect();
  try {
    await expect(
      db.store.readIndex(p.c, async (reader) => {
        await admin.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE datname=current_database() AND pid<>pg_backend_pid() AND state LIKE 'idle in transaction%'",
        );
        // Let the socket close and the client emit its 'error' event before the next query.
        await new Promise((r) => setTimeout(r, 200));
        return reader.searchSymbols("alpha", [], { limit: 5, offset: 0 });
      }),
    ).rejects.toBeInstanceOf(Error);
    const found = await db.store.readIndex(p.c, (reader) =>
      reader.searchSymbols("alpha", [], { limit: 5, offset: 0 }),
    );
    expect((found.results as { name: string }[]).map((s) => s.name)).toContain("alpha");
  } finally {
    await admin.end();
    await db.dispose();
    await p.f.dispose();
  }
});

it("samples unresolved references in id order without loading the snapshot", async () => {
  const db = await testDatabase();
  const p = await project(db, "export function alpha(){return 1}\n");
  try {
    const s = await db.store.snapshot(p.c);
    const symbol = s.symbols[0]!;
    const unresolved = Array.from({ length: 150 }, (_, n) => ({
      id: `ref-${String(149 - n).padStart(3, "0")}`,
      source: symbol.id,
      fileId: symbol.fileId,
      line: n + 1,
      expression: `missing${n}`,
      reason: "Unresolved",
      type: "CALLS",
    }));
    await publish(db.store, p.c, { ...s, unresolved, version: s.version + 1 });
    const sample = await db.store.unresolvedSample(p.c, 100);
    expect(sample.total).toBe(150);
    expect(sample.results).toHaveLength(100);
    expect(sample.results.map((r: { id: string }) => r.id)).toEqual(
      unresolved
        .map((r) => r.id)
        .sort()
        .slice(0, 100),
    );
  } finally {
    await db.dispose();
    await p.f.dispose();
  }
});

it("adds migration 10's file metadata without rewriting files and backfills it in batches", async () => {
  const db = await testDatabase();
  const p = await project(db, "export function alpha(){return 1}\n");
  const metadata = async () =>
    (
      await db.store.pool.query(
        `SELECT path,hash,file_status,analysis_hash,data->>'hash' AS data_hash,data->>'status' AS data_status,
           data->>'analysisHash' AS data_analysis_hash FROM files WHERE repository_id=$1 ORDER BY path`,
        [p.c.projectScopeId],
      )
    ).rows;
  const relfilenode = async () =>
    (await db.store.pool.query("SELECT relfilenode FROM pg_class WHERE relname='files'")).rows[0]
      .relfilenode as number;
  try {
    const state = await db.store.indexState(p.c);
    // Rebuild the pre-migration-10 schema around the already indexed rows.
    await db.store.pool.query(`
      DROP INDEX files_metadata_pending, files_path_c;
      ALTER TABLE files DROP COLUMN hash, DROP COLUMN file_status, DROP COLUMN analysis_hash;
      ALTER TABLE repositories DROP COLUMN version_floor;
      CREATE INDEX symbols_fuzzy ON symbols USING gin(name gin_trgm_ops);
      DELETE FROM schema_migrations WHERE version=10`);
    const before = await relfilenode();
    await db.store.migrate();
    // Adding nullable columns is catalog-only: a table rewrite would allocate a new relfilenode.
    expect(await relfilenode()).toBe(before);
    const rows = await metadata();
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.hash).toBe(row.data_hash);
      expect(row.file_status).toBe(row.data_status);
      expect(row.analysis_hash).toBe(row.data_analysis_hash);
      expect(row.file_status).toBe("INDEXED");
    }
    expect(await db.store.indexState(p.c)).toEqual(state);

    // Readers fall back to the jsonb fields until a row is backfilled.
    await db.store.pool.query(
      "UPDATE files SET hash=NULL,file_status=NULL,analysis_hash=NULL WHERE repository_id=$1",
      [p.c.projectScopeId],
    );
    expect(await db.store.indexState(p.c)).toEqual(state);
    // A row without a status stays pending but cannot stall the keyset cursor.
    await db.store.pool.query(
      "UPDATE files SET data=data-'status' WHERE repository_id=$1 AND path='a.ts'",
      [p.c.projectScopeId],
    );
    await db.store.backfillFileMetadata(1);
    const [a, b] = await metadata();
    expect(a).toMatchObject({ path: "a.ts", file_status: null, hash: a!.data_hash });
    expect(b).toMatchObject({ path: "b.ts", file_status: "INDEXED", hash: b!.data_hash });

    // Publication writes the columns explicitly, including for a row still pending backfill.
    await writeFile(join(p.f.root, "a.ts"), "export function alpha(){return 2}\n");
    await p.index.index();
    const [published] = await metadata();
    expect(published).toMatchObject({ path: "a.ts", file_status: "INDEXED" });
    expect(published!.hash).toBe(published!.data_hash);
    expect(published!.analysis_hash).toBe(published!.data_analysis_hash);
  } finally {
    await db.dispose();
    await p.f.dispose();
  }
});

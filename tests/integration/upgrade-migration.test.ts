import type { ProjectContext } from "@codememory/core";
import { requiredSchemaVersion } from "@codememory/database";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it } from "vitest";
import { migrateRuntimeDatabases } from "../../scripts/setup/activation";

type Database = Awaited<ReturnType<typeof testDatabase>>;
const files = {
  "a.ts": "export function alpha(){return 1}\n",
  "b.ts": "import {alpha} from './a';\nexport function useAlpha(){return alpha()}\n",
};
const registration = (root: string, managed: boolean) => ({
  root,
  client: "claude" as const,
  managed,
  enabled: true,
});
const schemaVersion = async (db: Database) =>
  (await db.store.pool.query("SELECT max(version)::int AS v FROM schema_migrations")).rows[0]
    .v as number;

/** Rows exactly as alpha.34 (schema 9) published them: jsonb only, edges with constraints. */
async function alpha34Project(db: Database, root: string) {
  const c = await createProjectContext(root);
  await db.store.register(c);
  const plugin = new TypeScriptPlugin();
  const scan = await new RepositoryScanner().scan(c, plugin.configurationReferences);
  for (const file of scan.files)
    await db.store.pool.query(
      "INSERT INTO files(repository_id,id,path,data) VALUES($1,$2,$3,$4) ON CONFLICT(repository_id,id) DO UPDATE SET data=EXCLUDED.data,path=EXCLUDED.path",
      [
        c.projectScopeId,
        file.id,
        file.path,
        JSON.stringify({ ...file, hash: `old-${file.path}`, analysisHash: "alpha34" }),
      ],
    );
  const fileId = scan.files[0]?.id;
  await db.store.pool.query(
    "INSERT INTO symbols(repository_id,id,file_id,name,qualified_name,data) VALUES($1,'legacy',$2,'legacy','legacy',$3)",
    [c.projectScopeId, fileId, JSON.stringify({ id: "legacy", fileId, name: "legacy" })],
  );
  await db.store.pool.query(
    "INSERT INTO symbol_edges(repository_id,id,source_id,target_id,file_id,edge_type,data) VALUES($1,'legacy-edge','legacy','legacy',$2,'CALLS','{}')",
    [c.projectScopeId, fileId],
  );
  await db.store.pool.query(
    "UPDATE repositories SET version=3,fingerprint='alpha34',indexed_at=now() WHERE id=$1",
    [c.projectScopeId],
  );
  return { c, plugin };
}

it("activation migrates an alpha.34 managed database before the new runtime indexes it", async () => {
  const db = await testDatabase({ through: 9 });
  const f = await fixture(files);
  try {
    const { c, plugin } = await alpha34Project(db, f.root);
    const index = new IndexService(c, db.store, new RepositoryScanner(), plugin);
    // The new runtime names the cause instead of failing with "column does not exist".
    await expect(index.index()).rejects.toMatchObject({ code: "SCHEMA_OUTDATED" });

    await migrateRuntimeDatabases([registration(f.root, true)], { managedUrl: async () => db.url });
    expect(await schemaVersion(db)).toBe(requiredSchemaVersion);
    expect(requiredSchemaVersion).toBe(15);
    expect(
      (
        await db.store.pool.query(
          "SELECT conname FROM pg_constraint WHERE conrelid='symbol_edges'::regclass AND contype IN ('p','f')",
        )
      ).rows,
    ).toEqual([]);
    // Existing rows were backfilled from their jsonb fields.
    const rows = (
      await db.store.pool.query(
        "SELECT hash,file_status,analysis_hash FROM files WHERE repository_id=$1 ORDER BY path",
        [c.projectScopeId],
      )
    ).rows;
    expect(rows.map((r) => r.analysis_hash)).toEqual(["alpha34", "alpha34"]);
    expect(rows.map((r) => r.file_status)).toEqual(["INDEXED", "INDEXED"]);

    const result = await index.index();
    expect(result.version).toBe(4);
    const legacy = await db.store.pool.query(
      "SELECT (SELECT count(*)::int FROM symbols WHERE repository_id=$1 AND id='legacy') AS symbols,(SELECT count(*)::int FROM symbol_edges WHERE repository_id=$1 AND id='legacy-edge') AS edges",
      [c.projectScopeId],
    );
    expect(legacy.rows[0]).toEqual({ symbols: 0, edges: 0 });
    expect((await index.index()).reason).toBe("UNCHANGED");
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

it("activation refuses an external database that is behind and accepts it once migrated", async () => {
  const db = await testDatabase({ through: 9 });
  const f = await fixture(files);
  try {
    const external = [registration(f.root, false)];
    await expect(migrateRuntimeDatabases(external, { externalUrl: db.url })).rejects.toThrow(
      "bun scripts/migrate.ts",
    );
    // Activation only checks an external database; it never migrates it.
    expect(await schemaVersion(db)).toBe(9);
    await db.store.migrate();
    await expect(
      migrateRuntimeDatabases(external, { externalUrl: db.url }),
    ).resolves.toBeUndefined();
    // An empty database holds nothing to protect; activation continues with an instruction.
    const empty = await testDatabase({ through: 0 });
    try {
      await expect(
        migrateRuntimeDatabases(external, { externalUrl: empty.url }),
      ).resolves.toContain("bun scripts/migrate.ts");
    } finally {
      await empty.dispose();
    }
    // An unreachable database cannot be checked; activation continues with an instruction.
    const unreachable = new URL(db.url);
    unreachable.port = "1";
    await expect(
      migrateRuntimeDatabases(external, { externalUrl: unreachable.href }),
    ).resolves.toContain("bun scripts/migrate.ts");
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

it("migration 12 repairs metadata columns an older writer left behind its data", async () => {
  const db = await testDatabase();
  const f = await fixture(files);
  try {
    const c: ProjectContext = await createProjectContext(f.root);
    await db.store.register(c);
    await new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin()).index();
    // Rebuild the pre-migration-12 schema, then let an alpha.34-style data-only write drift.
    await db.store.pool.query(`
      DROP TRIGGER files_metadata_from_data ON files;
      DROP FUNCTION files_metadata_from_data();
      DELETE FROM schema_migrations WHERE version=12`);
    await db.store.pool.query(
      `UPDATE files SET data=data||'{"hash":"drifted","analysisHash":"drifted"}' WHERE repository_id=$1 AND path='a.ts'`,
      [c.projectScopeId],
    );
    const drifted = async () =>
      (
        await db.store.pool.query(
          "SELECT count(*)::int AS n FROM files WHERE repository_id=$1 AND (hash IS DISTINCT FROM data->>'hash' OR analysis_hash IS DISTINCT FROM data->>'analysisHash' OR file_status IS DISTINCT FROM data->>'status')",
          [c.projectScopeId],
        )
      ).rows[0].n as number;
    expect(await drifted()).toBe(1);
    await db.store.migrate();
    expect(await drifted()).toBe(0);
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

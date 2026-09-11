import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { defaultDatabaseUrl, PostgresStore } from "@codememory/database";
import pg from "pg";
export async function fixture(files: Record<string, string>) {
  const root = await realpath(await mkdtemp(resolve(tmpdir(), "codememory-")));
  for (const [name, content] of Object.entries(files)) {
    const path = resolve(root, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, content);
  }
  return { root, dispose: () => rm(root, { recursive: true, force: true }) };
}
/** Every suite gets a new database; never migrate a supplied database directly. */
export async function testDatabase() {
  const admin = new pg.Pool({
    connectionString: process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl,
  });
  const name = `codememory_test_${randomUUID().replaceAll("-", "")}`;
  await admin.query(`CREATE DATABASE "${name}"`);
  const url = new URL(process.env.TEST_DATABASE_URL ?? defaultDatabaseUrl);
  url.pathname = `/${name}`;
  const store = new PostgresStore(url.href);
  await store.migrate();
  return {
    store,
    url: url.href,
    dispose: async () => {
      await store.close();
      await admin.query(`DROP DATABASE "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}
export async function eventually(check: () => Promise<boolean>, timeout = 10000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error("Condition not reached before deadline");
}

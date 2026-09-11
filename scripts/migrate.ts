import { PostgresStore } from "@codememory/database";

const store = new PostgresStore();
try {
  if (process.argv.includes("--status"))
    console.log((await store.pool.query("SELECT * FROM schema_migrations ORDER BY version")).rows);
  else {
    await store.migrate();
    console.log("Migrations applied");
  }
} finally {
  await store.close();
}

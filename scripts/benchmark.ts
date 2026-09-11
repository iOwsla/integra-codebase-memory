import { CodebaseService } from "@codememory/application";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";

const count = Number(process.argv[2] ?? 1000);
if (!Number.isInteger(count) || count < 1 || count > 10000)
  throw new Error("File count must be 1..10000");
const files = Object.fromEntries(
  Array.from({ length: count }, (_, i) => [`f${i}.ts`, `export function f${i}(){return ${i}}`]),
);
const f = await fixture(files),
  db = await testDatabase();
try {
  const c = await createProjectContext(f.root);
  await db.store.register(c);
  const index = new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin());
  const timings: Record<string, number> = {};
  let t = performance.now();
  await index.index();
  timings.initialMs = performance.now() - t;
  t = performance.now();
  await index.index();
  timings.unchangedMs = performance.now() - t;
  t = performance.now();
  await new CodebaseService(c, db.store).execute("search_symbols", { query: "f50" });
  timings.searchMs = performance.now() - t;
  console.log(
    JSON.stringify({ files: count, ...timings, rssBytes: process.memoryUsage().rss }, null, 2),
  );
} finally {
  await db.dispose();
  await f.dispose();
}

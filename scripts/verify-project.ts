import { CodebaseService } from "@codememory/application";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { ProcessTypeScriptPlugin } from "@codememory/plugin-typescript/process";
import { contains, createProjectContext } from "@codememory/shared";
import { testDatabase } from "@codememory/test-utils";

// Explicit root only. A disposable database prevents touching an existing index.
const selected = await createProjectContext(process.argv[2]);
const maxFileSizeBytes = Number(process.argv[4] ?? selected.effectiveConfig.maxFileSizeBytes);
if (
  !Number.isInteger(maxFileSizeBytes) ||
  maxFileSizeBytes < 1024 ||
  maxFileSizeBytes > 16 * 1024 * 1024
)
  throw new Error("File-size override must be 1024..16777216 bytes");
const context = Object.freeze({
  ...selected,
  effectiveConfig: Object.freeze({ ...selected.effectiveConfig, maxFileSizeBytes }),
});
const query = process.argv[3] ?? "createSourceFile";
const db = await testDatabase();
try {
  await db.store.register(context);
  let observed = 0;
  const scanner = new RepositoryScanner((_event, path) => {
    if (!contains(context.canonicalRoot, path)) throw new Error("Scanner escaped explicit root");
    observed++;
  });
  const index = new IndexService(context, db.store, scanner, new ProcessTypeScriptPlugin());
  let started = performance.now();
  const first = await index.index();
  const indexMs = performance.now() - started;
  const snapshot = await db.store.snapshot(context);
  const ids = new Set(snapshot.symbols.map((s) => s.id));
  if (snapshot.edges.some((e) => !ids.has(e.source) || !ids.has(e.target)))
    throw new Error("Dangling edge");
  started = performance.now();
  const unchanged = await index.index();
  const unchangedMs = performance.now() - started;
  if (unchanged.reason !== "UNCHANGED" || unchanged.version !== first.version)
    throw new Error("No-op check failed");
  started = performance.now();
  const result = await new CodebaseService(context, db.store).execute("search_symbols", {
    query,
    limit: 5,
  });
  const searchMs = performance.now() - started;
  console.log(
    JSON.stringify(
      {
        root: context.canonicalRoot,
        files: snapshot.files.length,
        maxFileSizeBytes,
        skippedFiles: snapshot.files.filter((f) => f.status.startsWith("SKIPPED")).length,
        sourceBytes: snapshot.files.reduce((n, f) => n + f.size, 0),
        symbols: snapshot.symbols.length,
        edges: snapshot.edges.length,
        unresolved: snapshot.unresolved.length,
        diagnostics: snapshot.diagnostics.length,
        failedFiles: snapshot.files.filter((f) => f.status === "INDEX_ERROR").length,
        observed,
        indexMs,
        unchangedMs,
        searchMs,
        query,
        queryResults: (result.results as unknown[]).length,
        incomplete: result.incomplete,
        rssBytesAtEnd: process.memoryUsage().rss,
      },
      null,
      2,
    ),
  );
} finally {
  await db.dispose();
}

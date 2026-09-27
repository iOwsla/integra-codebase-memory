import { isAbsolute } from "node:path";
import { CodebaseService } from "@codememory/application";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { ProcessTypeScriptPlugin } from "@codememory/plugin-typescript/process";
import { createProjectContext } from "@codememory/shared";
import { testDatabase } from "@codememory/test-utils";

const projectAt = process.argv.indexOf("--project");
const queryAt = process.argv.indexOf("--query");
const forceSecond = process.argv.includes("--force-second");
const project = projectAt >= 0 ? process.argv[projectAt + 1] : undefined;
const query = queryAt >= 0 ? process.argv[queryAt + 1] : "Service";
if (!project || !isAbsolute(project) || !query)
  throw new Error(
    "Usage: bun scripts/profile-project.ts --project /absolute/root [--query Symbol] [--force-second]",
  );

// The selected source project is read-only. testDatabase creates and drops a
// dedicated disposable CodeMemory database on TEST_DATABASE_URL or the dev server.
const context = await createProjectContext(project);
const db = await testDatabase();
process.env.CODEMEMORY_PROFILE = "1";
let peakRss = process.memoryUsage().rss;
let peakParserRss = 0;
const sample = setInterval(() => {
  peakRss = Math.max(peakRss, process.memoryUsage().rss);
}, 100);
const sampleParser =
  process.platform === "win32"
    ? undefined
    : setInterval(() => {
        const result = Bun.spawnSync(["ps", "-axo", "ppid=,rss=,command="]);
        if (result.exitCode !== 0) return;
        for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
          if (!line.includes("/packages/plugin-typescript/src/worker.ts")) continue;
          const match = /^\s*(\d+)\s+(\d+)\s+/.exec(line);
          if (match?.[1] !== String(process.pid)) continue;
          peakParserRss = Math.max(peakParserRss, Number(match[2]) * 1024);
        }
      }, 1000);
try {
  await db.store.register(context);
  const stages = new Map<string, number>();
  const started = performance.now();
  const indexer = new IndexService(
    context,
    db.store,
    new RepositoryScanner(),
    new ProcessTypeScriptPlugin(),
    (progress) => stages.set(progress.stage, performance.now()),
  );
  const first = await indexer.index();
  const indexed = performance.now();
  const firstStages = new Map(stages);
  const queryStarted = performance.now();
  await new CodebaseService(context, db.store).execute("search_symbols", { query, limit: 20 });
  const queryMs = performance.now() - queryStarted;
  const secondStarted = performance.now();
  const second = await indexer.index(forceSecond);
  const secondMs = performance.now() - secondStarted;
  const status = await db.store.status(context);
  console.log(
    JSON.stringify(
      {
        indexedFiles: first.changed,
        excluded: first.excluded,
        initialMs: Math.round(indexed - started),
        scanMs: Math.round(
          (firstStages.get("ANALYZING") ?? indexed) - (firstStages.get("SCANNING") ?? started),
        ),
        analyzeMs: Math.round(
          (firstStages.get("PUBLISHING") ?? indexed) - (firstStages.get("ANALYZING") ?? started),
        ),
        publishMs: Math.round(
          (firstStages.get("COMPLETE") ?? indexed) - (firstStages.get("PUBLISHING") ?? started),
        ),
        queryMs: Math.round(queryMs),
        secondMs: Math.round(secondMs),
        secondForced: forceSecond,
        secondReason: second.reason,
        secondChangedFiles: second.changed,
        incomplete: status.incomplete,
        peakProcessRssMiB: Math.round(peakRss / 1048576),
        peakParserRssMiB: peakParserRss ? Math.round(peakParserRss / 1048576) : null,
      },
      null,
      2,
    ),
  );
} finally {
  clearInterval(sample);
  if (sampleParser) clearInterval(sampleParser);
  await db.dispose();
}

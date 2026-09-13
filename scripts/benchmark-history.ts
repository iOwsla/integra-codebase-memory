import { execFile } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { HistoryService } from "@codememory/history";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";

const exec = promisify(execFile);
const projectFlag = process.argv.indexOf("--project");
const f =
  projectFlag < 0
    ? await fixture(
        Object.fromEntries(
          Array.from({ length: 64 }, (_, i) => [
            `docs/rule-${i}.md`,
            `# Rule ${i}${"\nUse the shared refund service.\n".repeat(20)}`,
          ]),
        ),
      )
    : undefined;
const root = f?.root ?? resolve(process.argv[projectFlag + 1] ?? ".");
const db = await testDatabase();
let peak = process.memoryUsage().rss;
const sample = setInterval(() => {
  peak = Math.max(peak, process.memoryUsage().rss);
}, 20);
try {
  if (f) {
    const git = (args: string[]) =>
      exec("git", ["-C", root, ...args], {
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: "Test",
          GIT_AUTHOR_EMAIL: "test@example.test",
          GIT_COMMITTER_NAME: "Test",
          GIT_COMMITTER_EMAIL: "test@example.test",
        },
      });
    await git(["init"]);
    await git(["add", "."]);
    await git(["commit", "-m", "fx"]);
    for (let i = 0; i < 3; i++) {
      await writeFile(join(root, "refund.ts"), `export function refund(){return ${i};}`);
      await git(["add", "."]);
      await git(["commit", "-m", "fx"]);
    }
  }
  const context = await createProjectContext(root);
  await db.store.register(context);
  const history = new HistoryService(context, db.store);
  await history.configure({ documents: true, git: true, apply: true });
  const collect = async () => {
    let result = await history.collect({ batchSize: 100 });
    for (let i = 0; i < 10000 && result.state === "QUEUED"; i++)
      result = await history.collect({ jobId: result.jobId, batchSize: 100 });
    if (result.state !== "SUCCEEDED") throw new Error("Collection did not finish");
    return result;
  };
  const baseline = process.memoryUsage().rss;
  let start = performance.now();
  const initial = await collect();
  const initialMs = performance.now() - start;
  start = performance.now();
  await collect();
  const noOpMs = performance.now() - start;
  const durations: number[] = [];
  for (let i = 0; i < 20; i++) {
    start = performance.now();
    await history.search({ kind: "intent", query: "refund", limit: 3 });
    durations.push(performance.now() - start);
  }
  durations.sort((a, b) => a - b);
  const stats = await db.store.history(context).stats();
  const queryPlan = (
    await db.store.pool.query(
      "EXPLAIN (FORMAT JSON) SELECT id FROM history_segments WHERE repository_id=$1 AND to_tsvector('simple',coalesce(excerpt,'')) @@ plainto_tsquery('simple','refund')",
      [context.projectScopeId],
    )
  ).rows[0]["QUERY PLAN"];
  process.stdout.write(
    `${JSON.stringify(
      {
        fixture: f ? "64 documents, 4 fx commits" : "explicit selected local repository",
        initialMs,
        noOpMs,
        queryP50Ms: durations[9],
        queryP95Ms: durations[18],
        queries: 20,
        baselineRssBytes: baseline,
        sampledPeakRssBytes: peak,
        ...stats,
        gaps: initial.gaps ?? [],
        queryPlan,
        limitations: [
          "Single process, local disposable PostgreSQL",
          "20ms sampled process RSS, not Docker/PostgreSQL RAM",
          "No providers invoked; not a concurrency or Windows benchmark",
        ],
      },
      null,
      2,
    )}\n`,
  );
} finally {
  clearInterval(sample);
  await db.dispose();
  await f?.dispose();
}

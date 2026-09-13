import { performance } from "node:perf_hooks";
import { CodebaseService } from "@codememory/application";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { checkpointBudget } from "../packages/memory/src/checkpoints";

// Disposable synthetic comparison; not a whole-machine or production benchmark.
const db = await testDatabase();
const f = await fixture({ "shared.ts": "x".repeat(1024 * 1024) });
try {
  const context = await createProjectContext(f.root);
  await db.store.register(context);
  const app = new CodebaseService(context, db.store);
  const records = [];
  for (let i = 0; i < 5; i++) {
    const memory = await app.memory.remember({
      type: "DECISION",
      title: `Rule ${i}`,
      content: "Shared source rule",
    });
    records.push(
      (
        await app.memoryWorkflow.checkpoints.capture({
          memoryId: memory.id,
          implementation: "REPORTED_IMPLEMENTED",
          note: "Synthetic benchmark",
          links: [{ path: "shared.ts", role: "IMPLEMENTATION" }],
        })
      ).checkpoint,
    );
  }
  const timings = { baseline: [] as number[], shared: [] as number[] };
  const bytes = { baseline: 0, shared: 0 };
  const rssBefore = process.memoryUsage().rss;
  for (let iteration = 0; iteration < 20; iteration++) {
    for (const mode of (iteration % 2
      ? ["shared", "baseline"]
      : ["baseline", "shared"]) as (keyof typeof timings)[]) {
      const start = performance.now();
      const shared = checkpointBudget();
      for (const record of records) {
        const budget = mode === "shared" ? shared : checkpointBudget();
        const before = budget.bytes;
        await app.memoryWorkflow.checkpoints.inspect(record, budget);
        bytes[mode] += before - budget.bytes;
      }
      timings[mode].push(performance.now() - start);
    }
  }
  const summary = (mode: keyof typeof timings) => {
    const sorted = timings[mode].sort((a, b) => a - b);
    return { p50Ms: sorted[9], p95Ms: sorted[18], meanSourceBytesPerRequest: bytes[mode] / 20 };
  };
  console.log(
    JSON.stringify(
      {
        synthetic: true,
        iterations: 20,
        memories: 5,
        sourceBytes: 1024 * 1024,
        baseline: summary("baseline"),
        shared: summary("shared"),
        rssBefore,
        rssAfter: process.memoryUsage().rss,
        limitation:
          "Warm local files; RSS is not peak memory or Docker/PostgreSQL usage. No real repository indexing measured.",
      },
      null,
      2,
    ),
  );
} finally {
  await db.dispose();
  await f.dispose();
}

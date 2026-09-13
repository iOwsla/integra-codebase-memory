import assert from "node:assert/strict";
import { resolve } from "node:path";
import { createProjectContext } from "@codememory/shared";
import { eventually, fixture, testDatabase } from "@codememory/test-utils";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// Explicitly invoked live provider probe. Only synthetic messages and a disposable DB.
if (!process.argv.includes("--live"))
  throw new Error("Pass --live to authorize a synthetic Spark + Haiku CLI probe");
const db = await testDatabase();
const f = await fixture({
  "src/refunds.ts": "export function refund(quantity: number) { return quantity; }",
});
let client: Client | undefined;
const connect = async () => {
  const transport = new StdioClientTransport({
    command: "bun",
    args: [resolve("apps/cli/src/index.ts"), "mcp", "--project", f.root],
    env: {
      ...Object.fromEntries(
        Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
      ),
      DATABASE_URL: db.url,
      CODEMEMORY_UPDATE_CHECK: "0",
    },
    stderr: "pipe",
  });
  transport.stderr?.on("data", () => {});
  const c = new Client({ name: "synthetic-memory-verification", version: "1" });
  await c.connect(transport);
  return c;
};
const call = async (name: string, args: Record<string, unknown> = {}) => {
  assert(client);
  const result = await client.callTool({ name, arguments: args });
  const data = JSON.parse((result.content as { text: string }[])[0]?.text ?? "null");
  assert(!result.isError, JSON.stringify(data));
  return data;
};
try {
  const context = await createProjectContext(f.root);
  await db.store.register(context);
  await db.store.configureMemoryWorkflow(context, true);
  client = await connect();
  const started = Date.now();
  const queued = await call("submit_memory_batch", {
    sessionId: "synthetic-live-probe",
    batchId: "1",
    messages: [
      {
        id: "m1",
        role: "user",
        text: "Proje kuralı: iadeyi kaydetmeden önce iade miktarının pozitif olduğunu her zaman kontrol et.",
      },
      { id: "m2", role: "user", text: "My subscription already has a 20x usage allowance." },
    ],
  });
  let job: Record<string, unknown> = {};
  await eventually(async () => {
    job = (await call("list_memory_candidates", { jobId: queued.jobId })).job;
    return job.state === "SUCCEEDED" || job.state === "FAILED";
  }, 510000);
  assert.equal(job.state, "SUCCEEDED", JSON.stringify(job));
  const candidates = job.candidates as { id: string; claim: string; state: string }[];
  const ready = candidates.filter((c) => c.state === "READY");
  assert(ready.length > 0, "No requirement reached review");
  assert(
    !ready.some((c) => /20x|subscription|quota/i.test(c.claim)),
    "Account information was admitted",
  );
  assert.equal((await call("search_memory")).results.length, 0);
  const first = ready[0];
  assert(first);
  await call("review_memory_candidate", {
    jobId: queued.jobId,
    candidateId: first.id,
    action: "APPROVE",
    userApproval: "The test operator approves this synthetic refund-validation rule.",
  });
  await client.close();
  client = await connect();
  const recall = await call("recall_context", {
    task: "Implement refund validation",
    paths: ["src/refunds.ts"],
  });
  assert(recall.results.some((r: { content: string }) => r.content === first.claim));
  console.log(
    JSON.stringify(
      {
        passed: true,
        elapsedMs: Date.now() - started,
        candidateCount: candidates.length,
        readyCount: ready.length,
        approvedClaim: first.claim,
        metrics: job.metrics,
        mcpReconnectRecall: true,
        disposableDatabase: true,
      },
      null,
      2,
    ),
  );
} finally {
  await client?.close();
  await db.dispose();
  await f.dispose();
}

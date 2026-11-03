import { once } from "node:events";
import { Worker } from "node:worker_threads";
import type { IndexedFile, ProjectContext } from "@codememory/core";
import { TypeScriptPlugin } from "./index";

// stdin is consumed in full up front, so its end cannot signal parent death. Poll the
// parent pid instead: once the parent dies the worker is re-parented and must stop.
// Analysis is synchronous, so the poll runs on its own thread to fire while it is busy.
new Worker(
  `const { workerData } = require("node:worker_threads");
  setInterval(() => {
    if (process.ppid !== workerData) process.kill(process.pid, "SIGKILL");
  }, 1000);`,
  { eval: true, workerData: process.ppid },
).unref();
const input = JSON.parse(await Bun.stdin.text()) as {
  context: ProjectContext;
  files: IndexedFile[];
  configs: [string, string][];
  progress?: boolean;
};
let lastProgress = 0;
const analysis = await new TypeScriptPlugin(
  undefined,
  input.progress
    ? (event) => {
        if (event.phase === "SEMANTIC_FILE" && Date.now() - lastProgress < 100) return;
        lastProgress = Date.now();
        process.stdout.write(`${JSON.stringify({ type: "progress", value: event })}\n`);
      }
    : undefined,
).analyze(input.context, input.files, new Map(input.configs));
// Respect pipe backpressure and avoid one enormous serialized JSON string.
for (const [type, records] of Object.entries(analysis)) {
  for (const value of records) {
    if (!process.stdout.write(`${JSON.stringify({ type, value })}\n`))
      await once(process.stdout, "drain");
  }
}
process.stdout.write(`${JSON.stringify({ type: "complete" })}\n`);

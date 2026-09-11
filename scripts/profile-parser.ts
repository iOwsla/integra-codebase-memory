import { resolve } from "node:path";
import { RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";

const root = process.argv[2];
if (!root)
  throw new Error("Usage: bun scripts/profile-parser.ts /absolute/project [semantic-file-limit]");
const limit = process.argv[3] === undefined ? Infinity : Number(process.argv[3]);
if (limit !== Infinity && (!Number.isInteger(limit) || limit < 1))
  throw new Error("File limit must be a positive integer");
const context = await createProjectContext(resolve(root));
let completed = 0;
const stopped = new Error("Profile file budget reached");
const plugin = new TypeScriptPlugin(undefined, (event) => {
  console.log(JSON.stringify({ ...event, heapUsedBytes: process.memoryUsage().heapUsed }));
  if (event.phase === "SEMANTIC_FILE" && ++completed >= limit) throw stopped;
});
const started = performance.now();
const scan = await new RepositoryScanner().scan(context, plugin.configurationReferences);
console.log(
  JSON.stringify({
    phase: "SCAN",
    durationMs: performance.now() - started,
    files: scan.files.length,
  }),
);
try {
  await plugin.analyze(context, scan.files, scan.configs);
} catch (error) {
  if (error !== stopped) throw error;
  console.log(JSON.stringify({ phase: "STOPPED", complete: false, semanticFiles: completed }));
}

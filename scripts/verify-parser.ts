import { resolve } from "node:path";
import { RepositoryScanner } from "@codememory/indexer";
import { ProcessTypeScriptPlugin } from "@codememory/plugin-typescript/process";
import { configSchema, createProjectContext } from "@codememory/shared";

// Offline acceptance: no database, source execution, builds or index publication.
const root = process.argv[2];
if (!root)
  throw new Error(
    "Usage: bun scripts/verify-parser.ts /absolute/project [timeout-ms] [--progress]",
  );
const selected = await createProjectContext(resolve(root));
const context = {
  ...selected,
  effectiveConfig: Object.freeze(
    configSchema.parse({
      ...selected.effectiveConfig,
      ...(process.argv[3] ? { parserTimeoutMs: Number(process.argv[3]) } : {}),
    }),
  ),
};
let progressEvents = 0;
const plugin = new ProcessTypeScriptPlugin(
  undefined,
  process.argv[4] === "--progress"
    ? () => {
        progressEvents++;
      }
    : undefined,
);
const scanner = new RepositoryScanner();
const started = performance.now();
const scan = await scanner.scan(context, plugin.configurationReferences);
const scanMs = performance.now() - started;
const parsing = performance.now();
try {
  const analysis = await plugin.analyze(context, scan.files, scan.configs);
  const parseMs = performance.now() - parsing;
  const symbols = new Set(analysis.symbols.map((s) => s.id));
  const files = new Set(scan.files.map((f) => f.id));
  const duplicateSymbols = analysis.symbols.length - symbols.size;
  const duplicateEdges = analysis.edges.length - new Set(analysis.edges.map((e) => e.id)).size;
  const danglingEdges = analysis.edges.filter(
    (e) => !symbols.has(e.source) || !symbols.has(e.target),
  ).length;
  const foreignSymbols = analysis.symbols.filter((s) => !files.has(s.fileId)).length;
  console.log(
    JSON.stringify(
      {
        mode: "offline-parser",
        ...(process.argv[4] === "--progress" ? { progressEvents } : {}),
        parserVersion: plugin.version,
        scanMs,
        parseMs,
        files: scan.files.length,
        sourceBytes: scan.files.reduce((n, f) => n + f.size, 0),
        skippedFiles: scan.files.filter((f) => f.status !== "INDEXED").length,
        configs: scan.configs.size,
        symbols: symbols.size,
        edges: analysis.edges.length,
        unresolved: analysis.unresolved.length,
        diagnostics: analysis.diagnostics.length,
        duplicateSymbols,
        duplicateEdges,
        danglingEdges,
        foreignSymbols,
        incomplete:
          scan.files.some((f) => f.status !== "INDEXED") || analysis.diagnostics.length > 0,
      },
      null,
      2,
    ),
  );
  if (duplicateSymbols || duplicateEdges || danglingEdges || foreignSymbols) process.exitCode = 1;
} catch (error) {
  console.error(
    JSON.stringify({
      mode: "offline-parser",
      scanMs,
      parseMs: performance.now() - parsing,
      files: scan.files.length,
      error: error instanceof Error ? error.message : "Parser failed",
    }),
  );
  process.exitCode = 1;
}

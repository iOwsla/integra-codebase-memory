import { mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProjectContext } from "@codememory/shared";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import type * as TS from "typescript";

// Read-only quality and latency evaluation of an existing published index.
// The TypeScript language service of the target tsconfig is the reference oracle.
const arg = (name: string, fallback?: string) => {
  const at = process.argv.indexOf(`--${name}`);
  return at >= 0 ? process.argv[at + 1] : fallback;
};
const project = arg("project");
const tsconfigArg = arg("tsconfig");
const sampleSize = Number(arg("sample", "60"));
const seed = Number(arg("seed", "1"));
const iterations = Number(arg("iterations", "20"));
const out = arg("out");
// Runtime root whose scripts/managed-mcp.ts serves the index; defaults to this checkout.
const runtime = arg("runtime") ?? fileURLToPath(new URL("..", import.meta.url));
// --unmanaged indexes into the migrated DATABASE_URL from the environment with the
// runtime's own CLI, so an unreleased analyzer can be measured against a disposable database.
const unmanaged = process.argv.includes("--unmanaged");
if (!project || !isAbsolute(project) || !tsconfigArg || (unmanaged && !process.env.DATABASE_URL))
  throw new Error(
    "Usage: bun scripts/evaluate-project.ts --project /absolute/root --tsconfig relative/tsconfig.json [--sample 60] [--seed 1] [--iterations 20] [--runtime /installed/release] [--unmanaged (requires DATABASE_URL)] [--out report.json]",
  );
// A managed registration makes the CLI ignore DATABASE_URL, and an unreleased analyzer
// would then republish the live index. Only disposable databases are accepted, and the
// server gets an empty management directory so no registration applies.
// Management paths must not traverse symlinks (macOS tmpdir is under /var -> /private/var).
const isolated = unmanaged
  ? realpathSync(mkdtempSync(resolve(tmpdir(), "codememory-eval-")))
  : undefined;
if (unmanaged) {
  const name = new URL(process.env.DATABASE_URL as string).pathname.slice(1);
  if (!/^codememory_(eval|test)_[0-9a-f]{32}$/.test(name))
    throw new Error("--unmanaged requires a disposable codememory_eval_/codememory_test_ database");
  mkdirSync(resolve(isolated as string, "cli/projects"), { recursive: true });
}

const context = await createProjectContext(project);
const root = context.canonicalRoot;
const tsconfig = resolve(root, tsconfigArg);
const rel = (file: string) => relative(root, file).split("\\").join("/");

type Ref = {
  file: string;
  line: number;
  kind: "import" | "decl" | "call" | "new" | "use" | "sibling";
};
type Candidate = {
  name: string;
  kind: string;
  file: string;
  nameLine: number;
  startLine: number;
  pos: number;
};
type Row = Record<string, unknown> & {
  id: string;
  file: string;
  startLine: number;
  name: string;
  kind: string;
};

// ---------- oracle ----------
function loadTypeScript(): typeof TS {
  try {
    return createRequire(tsconfig)("typescript");
  } catch {
    return createRequire(import.meta.url)("typescript");
  }
}
const ts = loadTypeScript();
const parsed = ts.getParsedCommandLineOfConfigFile(
  tsconfig,
  {},
  {
    ...ts.sys,
    onUnRecoverableConfigFileDiagnostic: (d) => {
      throw new Error(ts.flattenDiagnosticMessageText(d.messageText, "\n"));
    },
  },
);
if (!parsed) throw new Error("tsconfig could not be parsed");
const versions = new Map<string, string>();
const service = ts.createLanguageService(
  {
    getScriptFileNames: () => parsed.fileNames,
    getScriptVersion: (f) => versions.get(f) ?? "1",
    getScriptSnapshot: (f) => {
      const text = ts.sys.readFile(f);
      return text === undefined ? undefined : ts.ScriptSnapshot.fromString(text);
    },
    getCurrentDirectory: () => dirname(tsconfig),
    getCompilationSettings: () => parsed.options,
    getDefaultLibFileName: (o) => ts.getDefaultLibFilePath(o),
    fileExists: ts.sys.fileExists,
    readFile: ts.sys.readFile,
    readDirectory: ts.sys.readDirectory,
    directoryExists: ts.sys.directoryExists,
    getDirectories: ts.sys.getDirectories,
  },
  ts.createDocumentRegistry(),
);
let started = performance.now();
const program = service.getProgram();
if (!program) throw new Error("TypeScript program unavailable");
const oracleProgramMs = performance.now() - started;
const inProject = (f: string) =>
  !f.includes("/node_modules/") && !f.endsWith(".d.ts") && !relative(root, f).startsWith("..");

const candidates: Candidate[] = [];
for (const sf of program.getSourceFiles()) {
  if (!inProject(sf.fileName) || /\/generated\/|\.(spec|test)\.tsx?$/.test(sf.fileName)) continue;
  const visit = (node: TS.Node) => {
    let name: TS.Identifier | undefined;
    let kind = "";
    if (ts.isFunctionDeclaration(node) && node.name) [name, kind] = [node.name, "FUNCTION"];
    else if (ts.isClassDeclaration(node) && node.name) [name, kind] = [node.name, "CLASS"];
    else if (
      ts.isMethodDeclaration(node) &&
      ts.isIdentifier(node.name) &&
      ts.isClassLike(node.parent)
    )
      [name, kind] = [node.name, "METHOD"];
    if (name && name.text.length > 2)
      candidates.push({
        name: name.text,
        kind,
        file: rel(sf.fileName),
        nameLine: sf.getLineAndCharacterOfPosition(name.getStart(sf)).line + 1,
        startLine: sf.getLineAndCharacterOfPosition(node.getStart(sf)).line + 1,
        pos: name.getStart(sf),
      });
    ts.forEachChild(node, visit);
  };
  visit(sf);
}

// Deterministic stratified sample: equal share per declaration kind.
let state = seed >>> 0;
const random = () => {
  state = (state + 0x6d2b79f5) >>> 0;
  let t = state;
  t = Math.imul(t ^ (t >>> 15), t | 1);
  t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const byKind = new Map<string, Candidate[]>();
for (const c of candidates) byKind.set(c.kind, [...(byKind.get(c.kind) ?? []), c]);
const sample: Candidate[] = [];
for (const [, group] of byKind) {
  const pool = [...group];
  for (let i = 0; i < Math.ceil(sampleSize / byKind.size) && pool.length; i++)
    sample.push(...pool.splice(Math.floor(random() * pool.length), 1));
}

function classify(node: TS.Node): Ref["kind"] {
  for (let n: TS.Node = node; n; n = n.parent)
    if (ts.isImportDeclaration(n) || ts.isExportDeclaration(n) || ts.isImportEqualsDeclaration(n))
      return "import";
  // Sibling implementations of the same interface member are related declarations, not uses.
  const declaration = node.parent;
  if (
    (declaration as TS.NamedDeclaration).name === node &&
    (ts.isMethodDeclaration(declaration) ||
      ts.isMethodSignature(declaration) ||
      ts.isPropertyDeclaration(declaration) ||
      ts.isPropertySignature(declaration) ||
      ts.isFunctionDeclaration(declaration) ||
      ts.isClassDeclaration(declaration) ||
      ts.isInterfaceDeclaration(declaration))
  )
    return "decl";
  let callee: TS.Node = node;
  if (ts.isPropertyAccessExpression(node.parent) && node.parent.name === node) callee = node.parent;
  const parent = callee.parent;
  if (ts.isNewExpression(parent) && parent.expression === callee) return "new";
  if (ts.isCallExpression(parent) && parent.expression === callee) return "call";
  if (ts.isDecorator(parent)) return "call";
  return "use";
}

const checker = program.getTypeChecker();
// Declarations of the target's class and its IMPLEMENTS/EXTENDS ancestors.
function hierarchy(owner: TS.Node): Set<TS.Node> {
  const seen = new Set<TS.Node>();
  const visit = (node: TS.Node) => {
    if (seen.has(node) || !(ts.isClassLike(node) || ts.isInterfaceDeclaration(node))) return;
    seen.add(node);
    for (const clause of node.heritageClauses ?? [])
      for (const type of clause.types)
        for (const d of checker.getTypeAtLocation(type.expression).getSymbol()?.declarations ?? [])
          visit(d);
  };
  visit(owner);
  return seen;
}
function oracleRefs(c: Candidate): Ref[] {
  const found = service.findReferences(resolve(root, c.file), c.pos) ?? [];
  const target = program?.getSourceFile(resolve(root, c.file));
  const targetNode = target
    ? (
        ts as unknown as { getTouchingPropertyName(s: TS.SourceFile, p: number): TS.Node }
      ).getTouchingPropertyName(target, c.pos).parent
    : undefined;
  const ancestors = targetNode?.parent ? hierarchy(targetNode.parent) : new Set<TS.Node>();
  const refs: Ref[] = [];
  for (const group of found)
    for (const r of group.references) {
      if (r.isDefinition || !inProject(r.fileName)) continue;
      const sf = program?.getSourceFile(r.fileName);
      if (!sf) continue;
      const node = (
        ts as unknown as { getTouchingPropertyName(s: TS.SourceFile, p: number): TS.Node }
      ).getTouchingPropertyName(sf, r.textSpan.start);
      let kind = classify(node);
      // TypeScript groups every implementation of an interface member. A use that
      // resolves to a sibling implementation is not a use of this declaration.
      const member = targetNode?.parent && ts.isClassLike(targetNode.parent);
      if (member && (kind === "call" || kind === "use")) {
        let symbol = checker.getSymbolAtLocation(node);
        if (symbol && symbol.flags & ts.SymbolFlags.Alias)
          symbol = checker.getAliasedSymbol(symbol);
        const declarations = symbol?.declarations ?? [];
        if (
          declarations.length &&
          !declarations.some((d) => d === targetNode || (d.parent && ancestors.has(d.parent)))
        )
          kind = "sibling";
      }
      refs.push({
        file: rel(r.fileName),
        line: sf.getLineAndCharacterOfPosition(r.textSpan.start).line + 1,
        kind,
      });
    }
  return refs;
}

// ---------- MCP ----------
const transport = new StdioClientTransport({
  command: process.execPath,
  args: unmanaged
    ? [resolve(runtime, "apps/cli/src/index.ts"), "mcp", "--project", root, "--auto-index"]
    : [resolve(runtime, "scripts/managed-mcp.ts"), "mcp", "--project", root],
  env: {
    ...Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
    ),
    ...(isolated ? { CODEMEMORY_SERVICE_DIR: resolve(isolated, "service") } : {}),
  },
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => process.stderr.write(chunk));
const client = new Client({ name: "codememory-evaluation", version: "1.0.0" });
const latency = new Map<string, number[]>();
async function call(name: string, args: Record<string, unknown>) {
  const t = performance.now();
  const result = await client.callTool({ name, arguments: args });
  const ms = performance.now() - t;
  latency.set(name, [...(latency.get(name) ?? []), ms]);
  if (result.isError)
    throw new Error(`${name} failed: ${JSON.stringify(result.content).slice(0, 300)}`);
  const content = result.content as { type: string; text?: string }[];
  return (result.structuredContent ?? JSON.parse(content[0]?.text ?? "{}")) as Record<
    string,
    unknown
  >;
}
// The tools accept offsets up to this bound; anything beyond it cannot be read.
const maxOffset = 100_000;
async function all(name: string, args: Record<string, unknown>) {
  const rows: Record<string, unknown>[] = [];
  let offset = 0;
  for (;;) {
    const r = await call(name, { ...args, limit: 100, offset });
    rows.push(...((r.results as Record<string, unknown>[]) ?? []));
    if (!r.hasMore) return rows;
    // Scoring a truncated page set would report unrequested rows as misses.
    if (typeof r.nextOffset !== "number" || r.nextOffset > maxOffset)
      throw new Error(
        `${name} pagination exceeded offset ${maxOffset} for ${JSON.stringify(args)}`,
      );
    offset = r.nextOffset;
  }
}
const at = (row: Record<string, unknown>) => {
  const symbol = row.symbol as { file?: string } | undefined;
  return `${symbol?.file ?? row.file}:${row.line}`;
};
const percentile = (values: number[], p: number) => {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)] ?? 0;
};
const ratio = (a: number, b: number) => (b ? Math.round((a / b) * 1000) / 10 : null);

started = performance.now();
await client.connect(transport);
const connectMs = performance.now() - started;
try {
  let status = await call("codebase_status", {});
  let indexWaitMs = 0;
  for (const waited = performance.now(); unmanaged && performance.now() - waited < 900_000; ) {
    if (status.state === "READY" && status.pendingChanges === 0) break;
    await Bun.sleep(2000);
    status = await call("codebase_status", {});
    indexWaitMs = performance.now() - waited;
  }
  if (status.projectRoot !== root || status.state !== "READY")
    throw new Error(`Index not ready for ${root}: ${status.state}`);

  const oracleFiles = new Set(program.getSourceFiles().map((sf) => rel(sf.fileName)));
  const items: Record<string, unknown>[] = [];
  type Pair = [found: number, expected: number];
  const totals = {
    call: [0, 0] as Pair,
    new: [0, 0] as Pair,
    use: [0, 0] as Pair,
    any: [0, 0] as Pair,
    precision: [0, 0] as Pair,
    rank1: 0,
    rank5: 0,
    beyond100: 0,
    missing: 0,
    siblings: 0,
    rankUnknown: 0,
  };
  const isTarget = (c: Candidate) => (r: Row) =>
    r.file === c.file &&
    r.startLine >= c.startLine &&
    r.startLine <= c.nameLine &&
    r.kind !== "IMPORT";
  for (const c of sample) {
    const oracle = oracleRefs(c);
    const first = await call("search_symbols", { query: c.name, limit: 100 });
    const search = first.results as Row[];
    let rank = search.findIndex(isTarget(c));
    // Distinguish "ranked below the first page" from "absent"; extra pages are timed separately.
    // The server may reduce the page size, so always continue from nextOffset.
    let next = first.hasMore ? (first.nextOffset as number) : undefined;
    while (rank < 0 && next !== undefined && next <= maxOffset) {
      const t = performance.now();
      const page = await client.callTool({
        name: "search_symbols",
        arguments: { query: c.name, limit: 100, offset: next },
      });
      latency.set("search_symbols:deep", [
        ...(latency.get("search_symbols:deep") ?? []),
        performance.now() - t,
      ]);
      const body = page.structuredContent as {
        results?: Row[];
        hasMore?: boolean;
        nextOffset?: number;
      };
      const rows = body?.results ?? [];
      const found = rows.findIndex(isTarget(c));
      if (found >= 0) rank = search.length + found;
      search.push(...rows);
      next = body?.hasMore ? body.nextOffset : undefined;
    }
    if (rank < 0 && next !== undefined) {
      // Unread result pages remain: the rank is unknown, not evidence of absence.
      totals.rankUnknown++;
      items.push({ ...c, pos: undefined, rankUnknown: true, oracleRefs: oracle.length });
      continue;
    }
    if (rank < 0) {
      totals.missing++;
      items.push({ ...c, pos: undefined, missing: true, oracleRefs: oracle.length });
      continue;
    }
    if (rank === 0) totals.rank1++;
    if (rank < 5) totals.rank5++;
    if (rank >= 100) totals.beyond100++;
    const id = (search[rank] as Row).id;
    await call("get_symbol", { symbolId: id });
    const callers = new Set((await all("find_callers", { symbolId: id })).map(at));
    const references = new Set((await all("find_references", { symbolId: id })).map(at));
    const found = new Set([...callers, ...references]);
    const key = (r: Ref) => `${r.file}:${r.line}`;
    const calls = new Set(oracle.filter((r) => r.kind === "call").map(key));
    const news = new Set(oracle.filter((r) => r.kind === "new").map(key));
    const uses = new Set(oracle.filter((r) => r.kind === "use").map(key));
    const any = new Set([...calls, ...news, ...uses]);
    const everything = new Set(oracle.filter((r) => r.kind !== "sibling").map(key));
    totals.siblings += oracle.filter((r) => r.kind === "sibling").length;
    const hit = (s: Set<string>, by: Set<string>) => [...s].filter((x) => by.has(x));
    totals.call[0] += hit(calls, callers).length;
    totals.call[1] += calls.size;
    totals.new[0] += hit(news, found).length;
    totals.new[1] += news.size;
    totals.use[0] += hit(uses, found).length;
    totals.use[1] += uses.size;
    totals.any[0] += hit(any, found).length;
    totals.any[1] += any.size;
    // Only rows in files the oracle program covers can be confirmed or refuted.
    const judged = [...found].filter((x) => oracleFiles.has(x.slice(0, x.lastIndexOf(":"))));
    totals.precision[0] += judged.filter((x) => everything.has(x)).length;
    totals.precision[1] += judged.length;
    items.push({
      name: c.name,
      kind: c.kind,
      file: c.file,
      line: c.nameLine,
      searchRank: rank + 1,
      oracle: { calls: calls.size, news: news.size, uses: uses.size },
      mcp: { callers: callers.size, references: references.size },
      missedCalls: [...calls].filter((x) => !callers.has(x)).slice(0, 5),
      missedNews: [...news].filter((x) => !found.has(x)).slice(0, 5),
      missedUses: [...uses].filter((x) => !found.has(x)).slice(0, 5),
      unconfirmed: judged.filter((x) => !everything.has(x)).slice(0, 5),
    });
  }

  // Repeated mixed workload for steady-state latency.
  const resolved = items.filter((i) => !i.missing && !i.rankUnknown) as {
    name: string;
    file: string;
  }[];
  for (const item of Array.from(
    { length: resolved.length ? iterations : 0 },
    (_, i) => resolved[i % resolved.length] as { name: string; file: string },
  )) {
    await call("codebase_status", {});
    const rows = (await call("search_symbols", { query: item.name, limit: 20 })).results as Row[];
    const id = rows[0]?.id;
    if (id) {
      await call("find_callees", { symbolId: id, limit: 20 });
      await call("trace_dependencies", {
        fromSymbolId: id,
        direction: "incoming",
        edgeTypes: ["CALLS"],
        maxDepth: 3,
        maxPaths: 20,
      });
    }
    await call("get_file_outline", { path: item.file });
    await call("search_code", { query: item.name, limit: 20 });
  }

  const ranked = sample.length - totals.missing - totals.rankUnknown;
  const report = {
    project: root,
    tsconfig: rel(tsconfig),
    indexVersion: status.indexVersion,
    sample: {
      requested: sampleSize,
      evaluated: sample.length,
      candidates: candidates.length,
      seed,
    },
    setup: {
      mcpConnectMs: Math.round(connectMs),
      oracleProgramMs: Math.round(oracleProgramMs),
      ...(unmanaged ? { indexWaitMs: Math.round(indexWaitMs) } : {}),
    },
    index: {
      files: status.files,
      symbols: status.symbols,
      edges: status.edges,
      unresolvedReferences: status.unresolvedReferences,
    },
    quality: {
      symbolMissingPct: ratio(totals.missing, sample.length),
      searchRankUnknownPct: ratio(totals.rankUnknown, sample.length),
      searchTop1Pct: ratio(totals.rank1, ranked),
      searchTop5Pct: ratio(totals.rank5, ranked),
      searchBeyond100Pct: ratio(totals.beyond100, ranked),
      callerRecallPct: ratio(totals.call[0], totals.call[1]),
      instantiationRecallPct: ratio(totals.new[0], totals.new[1]),
      useRecallPct: ratio(totals.use[0], totals.use[1]),
      combinedRecallPct: ratio(totals.any[0], totals.any[1]),
      precisionPct: ratio(totals.precision[0], totals.precision[1]),
      oracleCounts: {
        calls: totals.call[1],
        news: totals.new[1],
        uses: totals.use[1],
        siblingImplementationsExcluded: totals.siblings,
      },
    },
    latencyMs: Object.fromEntries(
      [...latency].map(([name, v]) => [
        name,
        {
          n: v.length,
          p50: Math.round(percentile(v, 50)),
          p95: Math.round(percentile(v, 95)),
          max: Math.round(Math.max(...v)),
        },
      ]),
    ),
    items,
  };
  if (out) writeFileSync(out, `${JSON.stringify(report, null, 2)}\n`);
  console.log(JSON.stringify({ ...report, items: undefined }, null, 2));
} finally {
  await client.close();
  if (isolated) rmSync(isolated, { recursive: true, force: true });
}

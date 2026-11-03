import { relative } from "node:path";
import { RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture } from "@codememory/test-utils";
import ts from "typescript";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { CompilerWorkspace } from "../../packages/plugin-typescript/src/workspace";

const app = (name: string) => ({
  [`apps/${name}/package.json`]: `{"name":"${name}"}`,
  [`apps/${name}/main.ts`]: `import {shared} from '@x/shared'; export function ${name}(){shared()}`,
});
const config = (options: Record<string, unknown> = {}) =>
  JSON.stringify({
    compilerOptions: { strict: true, module: "nodenext", moduleResolution: "nodenext", ...options },
  });
const files = {
  "package.json": '{"workspaces":["apps/*","packages/*"]}',
  "packages/shared/package.json": '{"name":"@x/shared","type":"module","exports":"./index.ts"}',
  "packages/shared/tsconfig.json": config(),
  "packages/shared/index.ts": "import {util} from './util.js'; export function shared(){util()}",
  "packages/shared/util.ts": "export function util(){}",
  ...app("a"),
  "apps/a/tsconfig.json": config(),
  ...app("b"),
  "apps/b/tsconfig.json": config(),
  ...app("c"),
  "apps/c/tsconfig.json": config({ jsx: "react-jsx" }),
  ...app("d"),
  "apps/d/tsconfig.json": config({ moduleDetection: "force" }),
};

type Group = { config: string; files: Map<string, ts.SourceFile>; calls: string[] };
async function compile(f: { root: string }, uncached = false) {
  const context = await createProjectContext(f.root),
    plugin = new TypeScriptPlugin(),
    scan = await new RepositoryScanner().scan(context, plugin.configurationReferences),
    workspace = new CompilerWorkspace(context, scan.files, scan.configs, []),
    groups: Group[] = [];
  const name = (path: string) => relative(f.root, path);
  for (const { program, roots, config } of workspace.programs()) {
    const checker = program.getTypeChecker(),
      calls: string[] = [];
    for (const root of roots) {
      const sf = program.getSourceFile(root);
      const visit = (node: ts.Node) => {
        if (ts.isCallExpression(node)) {
          const target = checker.getResolvedSignature(node)?.declaration;
          calls.push(
            `${name(root)}:${node.getStart()} -> ${
              target ? `${name(target.getSourceFile().fileName)}:${target.getStart()}` : "?"
            }`,
          );
        }
        ts.forEachChild(node, visit);
      };
      if (sf) visit(sf);
    }
    groups.push({
      config: config ? name(config) : "",
      files: new Map(program.getSourceFiles().map((sf) => [name(sf.fileName), sf])),
      calls,
    });
    // Simulates the previous behaviour: every program parses and binds afresh.
    if (uncached)
      (workspace as unknown as { sourceFiles: Map<string, unknown> }).sourceFiles.clear();
  }
  return groups;
}

describe("SourceFile reuse across tsconfig groups", () => {
  let f: Awaited<ReturnType<typeof fixture>>;
  beforeAll(async () => {
    f = await fixture(files);
  });
  afterAll(() => f.dispose());

  it("parses each shared file once per compilation-settings key", async () => {
    const groups = await compile(f),
      get = (config: string) => groups.find((g) => g.config === config) as Group;
    expect(groups.map((g) => g.config).sort()).toEqual([
      "apps/a/tsconfig.json",
      "apps/b/tsconfig.json",
      "apps/c/tsconfig.json",
      "apps/d/tsconfig.json",
      "packages/shared/tsconfig.json",
    ]);
    const [a, b, c, d, shared] = [
      get("apps/a/tsconfig.json"),
      get("apps/b/tsconfig.json"),
      get("apps/c/tsconfig.json"),
      get("apps/d/tsconfig.json"),
      get("packages/shared/tsconfig.json"),
    ];
    for (const path of ["packages/shared/index.ts", "packages/shared/util.ts"]) {
      const first = a.files.get(path);
      expect(first, path).toBeDefined();
      // Same source-affecting options: the bound file is reused, including by
      // the group that owns it as a root.
      expect(b.files.get(path)).toBe(first);
      expect(shared.files.get(path)).toBe(first);
      // jsx and moduleDetection change parsing, so those groups get their own.
      expect(c.files.get(path)).toBeDefined();
      expect(c.files.get(path)).not.toBe(first);
      expect(d.files.get(path)).toBeDefined();
      expect(d.files.get(path)).not.toBe(first);
      expect(d.files.get(path)).not.toBe(c.files.get(path));
    }
  });

  it("resolves the same call targets as uncached programs", async () => {
    const cached = await compile(f),
      uncached = await compile(f, true);
    const calls = (groups: Group[]) => groups.flatMap((g) => g.calls).sort();
    expect(calls(cached)).toEqual(calls(uncached));
    expect(calls(cached)).toContain(
      `packages/shared/index.ts:${files["packages/shared/index.ts"].indexOf("util()")} -> packages/shared/util.ts:0`,
    );
    expect(calls(cached).some((c) => c.includes("?"))).toBe(false);
  });

  it("produces the expected call edges through the plugin", async () => {
    const context = await createProjectContext(f.root),
      plugin = new TypeScriptPlugin(),
      scan = await new RepositoryScanner().scan(context, plugin.configurationReferences),
      analysis = await plugin.analyze(context, scan.files, scan.configs);
    const fn = (name: string) =>
      analysis.symbols.find((s) => s.name === name && s.kind === "FUNCTION")?.id;
    const edges = new Set(
      analysis.edges.filter((e) => e.type === "CALLS").map((e) => `${e.source}>${e.target}`),
    );
    for (const caller of ["a", "b", "c", "d"])
      expect(edges.has(`${fn(caller)}>${fn("shared")}`), caller).toBe(true);
    expect(edges.has(`${fn("shared")}>${fn("util")}`)).toBe(true);
  });
});

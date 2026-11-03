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
  [`apps/${name}/main.ts`]: `import {shared} from '@x/shared'; import {local} from './local.js'; export function ${name}(){shared(); local()}`,
  [`apps/${name}/local.ts`]: "export function local(){}",
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
  // A later group that shares a's options but none of its files.
  "tools/x/tsconfig.json": config(),
  "tools/x/main.ts": "export function tool(){}",
};

type Group = {
  config: string;
  files: Map<string, ts.SourceFile>;
  calls: string[];
  cached: string[];
};
type Internals = {
  sourceFiles: Map<string, { file: ts.SourceFile }>;
  retainedTextLimit: number;
};
async function compile(f: { root: string }, uncached = false, retainedTextLimit?: number) {
  const context = await createProjectContext(f.root),
    plugin = new TypeScriptPlugin(),
    scan = await new RepositoryScanner().scan(context, plugin.configurationReferences),
    workspace = new CompilerWorkspace(context, scan.files, scan.configs, []),
    groups: Group[] = [];
  const internals = workspace as unknown as Internals;
  if (retainedTextLimit !== undefined) internals.retainedTextLimit = retainedTextLimit;
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
      cached: [...internals.sourceFiles.values()].map((e) => name(e.file.fileName)),
    });
    // Simulates the previous behaviour: every program parses and binds afresh.
    if (uncached) internals.sourceFiles.clear();
  }
  expect(internals.sourceFiles.size).toBe(0);
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
      "tools/x/tsconfig.json",
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

  it("releases each cached file after the last group that uses it", async () => {
    const groups = await compile(f);
    for (const [index, group] of groups.entries())
      for (const path of group.cached) {
        // Every retained file is in this program or a later one.
        const later = groups.slice(index).some((g) => g.files.has(path));
        expect(later, `${group.config}: ${path}`).toBe(true);
      }
    // Group-local files never outlive their own program.
    for (const [index, group] of groups.entries())
      if (group.config.startsWith("apps/")) {
        const local = `${group.config.slice(0, -"tsconfig.json".length)}local.ts`;
        expect(group.cached).toContain(local);
        for (const next of groups.slice(index + 1)) expect(next.cached).not.toContain(local);
      }
    // The shared package is still reused while later groups need it.
    const users = groups.filter((g) => g.files.has("packages/shared/util.ts"));
    expect(users.length).toBeGreaterThan(2);
    const last = groups.indexOf(users[users.length - 1] as Group);
    expect(last).toBeLessThan(groups.length - 1);
    for (const next of groups.slice(last + 1))
      expect(next.cached).not.toContain("packages/shared/util.ts");
  });

  it("bounds retained source text and stays correct when nothing is kept", async () => {
    const bounded = await compile(f, false, 0),
      uncached = await compile(f, true);
    // With no retention budget every cached file belongs to the current program.
    for (const group of bounded)
      for (const path of group.cached) expect(group.files.has(path), path).toBe(true);
    const a = bounded.find((g) => g.config === "apps/a/tsconfig.json") as Group,
      b = bounded.find((g) => g.config === "apps/b/tsconfig.json") as Group;
    expect(b.files.get("packages/shared/util.ts")).not.toBe(a.files.get("packages/shared/util.ts"));
    const calls = (groups: Group[]) => groups.flatMap((g) => g.calls).sort();
    expect(calls(bounded)).toEqual(calls(uncached));
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

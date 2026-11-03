import { RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture } from "@codememory/test-utils";
import { afterEach, expect, it, vi } from "vitest";

// Files whose name matches this pattern get a checker that throws, standing in
// for a TypeScript "Debug Failure" on one pathological file.
const failing = vi.hoisted(() => ({ pattern: undefined as RegExp | undefined }));
vi.mock("typescript", async (importOriginal) => {
  const actual = (await importOriginal()) as { default: typeof import("typescript") };
  const ts = actual.default;
  const patched = Object.create(ts) as typeof ts;
  Object.defineProperty(patched, "createProgram", {
    value: (...args: Parameters<typeof ts.createProgram>) => {
      const program = ts.createProgram(...args);
      const checker = program.getTypeChecker();
      const throwing = new Proxy(checker, {
        get(target, key, receiver) {
          const value = Reflect.get(target, key, receiver);
          if (key !== "getSymbolAtLocation" || typeof value !== "function") return value;
          return (node: import("typescript").Node) => {
            if (failing.pattern?.test(node.getSourceFile().fileName))
              throw new Error("Debug Failure. False expression.");
            return value.call(target, node);
          };
        },
      });
      return new Proxy(program, {
        get(target, key, receiver) {
          if (key === "getTypeChecker") return () => throwing;
          return Reflect.get(target, key, receiver);
        },
      });
    },
  });
  return { ...actual, default: patched };
});

afterEach(() => {
  failing.pattern = undefined;
});

async function analyze(files: Record<string, string>) {
  const f = await fixture({ "package.json": "{}", ...files });
  try {
    const context = await createProjectContext(f.root),
      plugin = new TypeScriptPlugin(),
      scan = await new RepositoryScanner().scan(context, plugin.configurationReferences);
    return await plugin.analyze(context, scan.files, scan.configs);
  } finally {
    await f.dispose();
  }
}

it("resolves namespace-import references to the FILE symbol, not the first declaration", async () => {
  const a = await analyze({
    "a.ts": "export function foo() {}\n",
    "b.ts": "import * as a from './a';\nvoid a;\n",
    "c.ts": "import { foo } from './a';\nexport const bar = foo;\n",
    "d.ts": "import * as c from './c';\nvoid c;\n",
  });
  const fileOf = (path: string) => a.symbols.find((s) => s.kind === "FILE" && s.file === path)!;
  const foo = a.symbols.find((s) => s.qualifiedName === "foo")!;
  const references = (source: string) =>
    a.edges.filter((e) => e.type === "REFERENCES" && e.source === fileOf(source).id);
  expect(references("b.ts")).toContainEqual(
    expect.objectContaining({ target: fileOf("a.ts").id, line: 2 }),
  );
  expect(references("b.ts").some((e) => e.target === foo.id)).toBe(false);
  // A target file that starts with an import also resolves to its FILE symbol.
  expect(references("d.ts")).toContainEqual(
    expect.objectContaining({ target: fileOf("c.ts").id, line: 2 }),
  );
});

it("keeps other files' relationships when the checker throws on one file", async () => {
  failing.pattern = /bad\.ts$/;
  const a = await analyze({
    "good.ts": "export function helper() {}\nexport function run() { helper(); }\n",
    "bad.ts": "import { helper } from './good';\nexport function broken() { helper(); }\n",
  });
  const named = (n: string) => a.symbols.find((s) => s.qualifiedName === n)!;
  expect(a.edges).toContainEqual(
    expect.objectContaining({ type: "CALLS", source: named("run").id, target: named("helper").id }),
  );
  // Symbols come from the syntax-only pass; the failed file keeps them.
  expect(named("broken")).toBeDefined();
  expect(a.edges.some((e) => e.type === "CALLS" && e.source === named("broken").id)).toBe(false);
  expect(a.diagnostics).toContainEqual(
    expect.objectContaining({
      kind: "ANALYSIS_ERROR",
      file: "bad.ts",
      message: expect.stringContaining("Debug Failure"),
    }),
  );
});

it("fails the analysis when the checker throws on too many files", async () => {
  failing.pattern = /bad\d+\.ts$/;
  const files: Record<string, string> = {};
  for (let index = 0; index < 21; index++)
    files[`bad${index}.ts`] = "export const x = 1;\nvoid x;\n";
  await expect(analyze(files)).rejects.toThrow("Debug Failure");
});

import { resolve } from "node:path";
import { RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture } from "@codememory/test-utils";
import { expect, it } from "vitest";

it("resolves member calls through standard library generics without indexing library symbols", async () => {
  const context = await createProjectContext(resolve("tests/fixtures/typescript/dispatch")),
    plugin = new TypeScriptPlugin(),
    scan = await new RepositoryScanner().scan(context, plugin.configurationReferences),
    a = await plugin.analyze(context, scan.files, scan.configs);
  const named = (n: string) => a.symbols.find((s) => s.qualifiedName === n)?.id;
  const calls = (source: string, target: string) =>
    a.edges.some(
      (e) => e.type === "CALLS" && e.source === named(source) && e.target === named(target),
    );
  expect(calls("Service.direct", "Handler.verify")).toBe(true);
  // Record<string, Handler> and Promise<Handler> need lib declarations to keep their element type.
  expect(calls("Service.viaUnion", "Handler.verify")).toBe(true);
  expect(calls("Service.viaPromise", "Handler.verify")).toBe(true);
  expect(calls("Service.concrete", "StripeHandler.verify")).toBe(true);
  // The callback parameter `load()` has no static target; member calls must resolve.
  expect(a.unresolved.filter((u) => u.expression.includes(".verify("))).toEqual([]);
  expect(a.symbols.every((s) => s.file.startsWith("src/") || s.file === "tsconfig.json")).toBe(
    true,
  );
});

it("loads the ES5 default library (lib.d.ts) for built-in generics", async () => {
  const f = await fixture({
    "tsconfig.json":
      '{"compilerOptions":{"target":"ES5","ignoreDeprecations":"6.0"},"include":["src"]}',
    "src/main.ts": [
      "export interface Handler { verify(): boolean }",
      "const handlers: Record<string, Handler> = {};",
      "export function run(k: string) { return handlers[k].verify(); }",
      "",
    ].join("\n"),
  });
  try {
    const context = await createProjectContext(f.root),
      plugin = new TypeScriptPlugin(),
      scan = await new RepositoryScanner().scan(context, plugin.configurationReferences),
      a = await plugin.analyze(context, scan.files, scan.configs);
    const named = (n: string) => a.symbols.find((s) => s.qualifiedName === n)?.id;
    expect(
      a.edges.some(
        (e) =>
          e.type === "CALLS" && e.source === named("run") && e.target === named("Handler.verify"),
      ),
    ).toBe(true);
  } finally {
    await f.dispose();
  }
});

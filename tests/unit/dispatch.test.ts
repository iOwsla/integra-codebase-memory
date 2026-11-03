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

it("merges receiver metadata permissively when calls on one line share a CALLS edge", async () => {
  const f = await fixture({
    "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["src"]}',
    "src/main.ts": [
      "export class Base { save() {} }",
      "export class A extends Base {}",
      "export class B extends Base { save() {} }",
      "export class C extends Base {",
      "  thisThenSuper() { this.save(); super.save(); }",
      "  superThenThis() { super.save(); this.save(); }",
      "  bothSuper() { super.save(); super.save(); }",
      "}",
      "export function mixed(base: Base, a: A) { const r = [base.save(), a.save()]; return r; }",
      "export function same(base: Base, other: Base) { return [base.save(), other.save()]; }",
      "",
    ].join("\n"),
  });
  try {
    const context = await createProjectContext(f.root),
      plugin = new TypeScriptPlugin(),
      scan = await new RepositoryScanner().scan(context, plugin.configurationReferences),
      a = await plugin.analyze(context, scan.files, scan.configs);
    const named = (n: string) => a.symbols.find((s) => s.qualifiedName === n)?.id;
    const call = (source: string) => {
      const edges = a.edges.filter(
        (e) => e.type === "CALLS" && e.source === named(source) && e.target === named("Base.save"),
      );
      expect(edges).toHaveLength(1);
      return edges[0]!;
    };
    // A receiver of type A or Base may reach B.save, so no receiverType may survive.
    expect(call("mixed").metadata).toBeUndefined();
    expect(call("same").metadata).toEqual({ receiverType: named("Base") });
    // A super call never dispatches, but a this-call on the same line can.
    expect(call("C.thisThenSuper").metadata).toBeUndefined();
    expect(call("C.superThenThis").metadata).toBeUndefined();
    expect(call("C.bothSuper").metadata).toEqual({ receiver: "super" });
  } finally {
    await f.dispose();
  }
});

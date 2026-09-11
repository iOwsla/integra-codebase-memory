import { resolve } from "node:path";
import { RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture } from "@codememory/test-utils";
import { describe, expect, it } from "vitest";

describe("TypeScript compiler plugin", () => {
  it("extracts declarations, semantic calls, aliases, inheritance, TSX and JS", async () => {
    const context = await createProjectContext(resolve("tests/fixtures/typescript/core"));
    const scan = await new RepositoryScanner().scan(context);
    const result = await new TypeScriptPlugin().analyze(context, scan.files, scan.configs);
    const named = (n: string) => result.symbols.find((s) => s.qualifiedName === n)!;
    for (const name of [
      "add",
      "asyncArrow",
      "Service.run",
      "Result",
      "State",
      "View",
      "jsEntry",
      "factory.nested",
    ])
      expect(named(name), name).toBeDefined();
    expect(named("asyncArrow").async).toBe(true);
    expect(named("asyncArrow").exported).toBe(true);
    expect(
      result.edges.some(
        (e) => e.source === named("entry").id && e.target === named("add").id && e.type === "CALLS",
      ),
    ).toBe(true);
    expect(
      result.edges.some(
        (e) =>
          e.source === named("Service").id && e.target === named("Base").id && e.type === "EXTENDS",
      ),
    ).toBe(true);
    expect(result.edges.some((e) => e.type === "IMPLEMENTS")).toBe(true);
    expect(result.unresolved.some((u) => u.expression.includes("missing"))).toBe(true);
    expect(new Set(result.symbols.map((s) => s.id)).size).toBe(result.symbols.length);
  });
  it("resolves per-project aliases with a hermetic compiler host", async () => {
    const f = await fixture({
      "tsconfig.json": JSON.stringify({
        compilerOptions: { baseUrl: ".", paths: { "@/*": ["src/*"] } },
      }),
      "src/value.ts": "export function value(){return 1}",
      "src/main.ts": "import {value} from '@/value'; export function main(){return value()}",
    });
    try {
      const c = await createProjectContext(f.root),
        scan = await new RepositoryScanner().scan(c);
      const a = await new TypeScriptPlugin().analyze(c, scan.files, scan.configs);
      const value = a.symbols.find((s) => s.name === "value" && s.kind === "FUNCTION")!;
      expect(a.edges.some((e) => e.type === "CALLS" && e.target === value.id)).toBe(true);
    } finally {
      await f.dispose();
    }
  });
});
it("regression-001: function expressions keep binding identity and block locals remain distinct", async () => {
  const c = await createProjectContext(
      resolve("tests/fixtures/typescript/regression-001-identities"),
    ),
    scan = await new RepositoryScanner().scan(c),
    a = await new TypeScriptPlugin().analyze(c, scan.files, scan.configs);
  const declared = a.symbols.find((s) => s.name === "declared"),
    caller = a.symbols.find((s) => s.name === "caller");
  expect(
    a.edges.some((e) => e.type === "CALLS" && e.source === caller?.id && e.target === declared?.id),
  ).toBe(true);
  expect(a.symbols.filter((s) => s.name === "same")).toHaveLength(2);
});
it("regression-002: nested unresolved calls have distinct identities", async () => {
  const c = await createProjectContext(
      resolve("tests/fixtures/typescript/regression-002-unresolved"),
    ),
    scan = await new RepositoryScanner().scan(c),
    a = await new TypeScriptPlugin().analyze(c, scan.files, scan.configs);
  expect(a.unresolved.filter((u) => u.type === "CALLS")).toHaveLength(2);
  expect(new Set(a.unresolved.map((u) => u.id)).size).toBe(a.unresolved.length);
});
it("regression-003: exported values, binding elements, overload ranges and accessors retain structure", async () => {
  const c = await createProjectContext(
      resolve("tests/fixtures/typescript/regression-003-declarations"),
    ),
    s = await new RepositoryScanner().scan(c),
    a = await new TypeScriptPlugin().analyze(c, s.files, s.configs);
  for (const name of ["count", "current", "first", "renamed"])
    expect(a.symbols.find((s) => s.name === name)?.exported, name).toBe(true);
  expect(a.symbols.find((s) => s.name === "first")?.kind).toBe("CONSTANT");
  const overload = a.symbols.find((s) => s.name === "overload");
  expect(overload?.startLine).toBe(4);
  expect(overload?.endLine).toBe(6);
  expect(a.symbols.filter((s) => s.name === "value" && s.kind === "METHOD")).toHaveLength(2);
  const target = a.symbols.find((s) => s.file === "target.ts" && s.kind === "FILE");
  expect(a.edges.some((e) => e.type === "IMPORTS" && e.target === target?.id)).toBe(true);
  expect(a.unresolved.some((u) => u.expression.startsWith("import("))).toBe(false);
});
it("regression-004: static CommonJS imports and exports retain their semantic targets", async () => {
  const c = await createProjectContext(
      resolve("tests/fixtures/typescript/regression-004-commonjs"),
    ),
    p = new TypeScriptPlugin(),
    s = await new RepositoryScanner().scan(c),
    a = await p.analyze(c, s.files, s.configs);
  const entry = a.symbols.find((s) => s.name === "entry" && s.kind === "FUNCTION"),
    answer = a.symbols.find((s) => s.name === "answer" && s.kind === "FUNCTION"),
    file = a.symbols.find((s) => s.file === "target.cjs" && s.kind === "FILE");
  expect(
    a.edges.some((e) => e.type === "CALLS" && e.source === entry?.id && e.target === answer?.id),
  ).toBe(true);
  expect(a.edges.some((e) => e.type === "IMPORTS" && e.target === file?.id)).toBe(true);
  expect(entry?.exported).toBe(true);
  expect(answer?.exported).toBe(true);
});
it("property-access references distinguish getter reads from setter writes", async () => {
  const c = await createProjectContext(
      resolve("tests/fixtures/typescript/regression-003-declarations"),
    ),
    s = await new RepositoryScanner().scan(c),
    a = await new TypeScriptPlugin().analyze(c, s.files, s.configs);
  const source = a.symbols.find((s) => s.name === "access"),
    get = a.symbols.find((s) => s.metadata.accessor === "get"),
    set = a.symbols.find((s) => s.metadata.accessor === "set");
  for (const target of [get, set])
    expect(
      a.edges.some(
        (e) => e.type === "REFERENCES" && e.source === source?.id && e.target === target?.id,
      ),
    ).toBe(true);
});

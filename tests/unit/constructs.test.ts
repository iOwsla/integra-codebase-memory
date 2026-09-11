import { resolve } from "node:path";
import type { Analysis } from "@codememory/core";
import { RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { beforeAll, describe, expect, it } from "vitest";

describe("v0.1 TypeScript construct coverage", () => {
  let a: Analysis;
  beforeAll(async () => {
    const c = await createProjectContext(resolve("tests/fixtures/typescript/constructs")),
      plugin = new TypeScriptPlugin(),
      s = await new RepositoryScanner().scan(c, plugin.configurationReferences);
    a = await plugin.analyze(c, s.files, s.configs);
  });
  const named = (name: string) => a.symbols.find((s) => s.qualifiedName === name);
  it("tracks generic/abstract classes, constructor and static method declarations", () => {
    expect(named("Base")?.kind).toBe("CLASS");
    expect(named("Base.build")?.static).toBe(true);
    expect(named("Concrete.constructor")?.kind).toBe("CONSTRUCTOR");
    expect(named("Concrete.run")?.signature).toContain("number");
    expect(
      a.edges.some(
        (e) =>
          e.source === named("Base.build")?.id &&
          e.target === named("target")?.id &&
          e.type === "CALLS",
      ),
    ).toBe(true);
  });
  it("resolves decorator identifiers semantically without framework inference", () => {
    expect(a.edges.some((e) => e.type === "REFERENCES" && e.target === named("decorate")?.id)).toBe(
      true,
    );
  });
  it("preserves namespace and object method ownership", () => {
    expect(named("Nested.execute")?.kind).toBe("FUNCTION");
    expect(named("object.invoke")?.kind).toBe("METHOD");
    for (const name of ["Nested.execute", "object.invoke", "Concrete.arrow"])
      expect(
        a.edges.some(
          (e) =>
            e.source === named(name)?.id && e.target === named("target")?.id && e.type === "CALLS",
        ),
        name,
      ).toBe(true);
  });
  it("links method chaining and destructured aliases to actual method definitions", () => {
    expect(
      a.edges.some(
        (e) =>
          e.source === a.symbols.find((s) => s.kind === "FILE" && s.file === "main.ts")?.id &&
          e.target === named("Concrete.run")?.id &&
          e.type === "CALLS",
      ),
    ).toBe(true);
    expect(
      a.edges.some(
        (e) =>
          e.source === named("viaBinding")?.id &&
          e.target === named("Concrete.run")?.id &&
          e.type === "CALLS",
      ),
    ).toBe(true);
  });
  it("extracts JSX, MJS, CJS and anonymous default exports", () => {
    expect(named("Element")?.kind).toBe("FUNCTION");
    expect(named("moduleFunction")?.kind).toBe("FUNCTION");
    expect(named("commonFunction")?.kind).toBe("FUNCTION");
    expect(named("default")?.exported).toBe(true);
  });
  it("connects local export aliases to their original declaration", () => {
    expect(a.edges.some((e) => e.type === "EXPORTS" && e.target === named("target")?.id)).toBe(
      true,
    );
    expect(named("export.alias")?.kind).toBe("EXPORT");
    expect(named("Concrete")?.metadata.tsconfig).toBe("tsconfig.json");
  });
});

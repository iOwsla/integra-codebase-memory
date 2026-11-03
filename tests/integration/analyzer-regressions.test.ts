import { CodebaseService } from "@codememory/application";
import type { CodeSymbol } from "@codememory/core";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it } from "vitest";

async function indexed(files: Record<string, string>) {
  const db = await testDatabase(),
    f = await fixture(files),
    c = await createProjectContext(f.root);
  try {
    await db.store.register(c);
    await new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin()).index();
    return {
      service: new CodebaseService(c, db.store),
      dispose: async () => {
        await db.dispose();
        await f.dispose();
      },
    };
  } catch (error) {
    await db.dispose();
    await f.dispose();
    throw error;
  }
}

it("keeps a dispatch caller whose same-line calls had different receiver types", async () => {
  const project = await indexed({
    "package.json": "{}",
    "tsconfig.json": '{"compilerOptions":{"strict":true},"include":["src"]}',
    "src/main.ts": [
      "export class Base { save() {} }",
      "export class A extends Base {}",
      "export class B extends Base { save() {} }",
      "export function mixed(base: Base, a: A) { const r = [base.save(), a.save()]; return r; }",
      "",
    ].join("\n"),
  });
  try {
    const { results } = await project.service.execute("find_callers", {
      name: "B.save",
      limit: 20,
    });
    expect(
      (results as { symbol: CodeSymbol; dispatch?: { via: { qualifiedName: string } } }[]).map(
        (r) => [r.symbol.qualifiedName, r.dispatch?.via.qualifiedName ?? null],
      ),
    ).toEqual([["mixed", "Base.save"]]);
  } finally {
    await project.dispose();
  }
});

it("publishes a schema whose composite relation is missing several fields", async () => {
  const project = await indexed({
    "package.json": "{}",
    "schema.prisma": [
      'generator client {\n provider = "prisma-client-js"\n}',
      "model A {\n id Int @id\n x Int\n y Int\n b B @relation(fields:[p,q], references:[x,y])\n}",
      "model B {\n x Int\n y Int\n a A[]\n @@id([x,y])\n}",
      "",
    ].join("\n"),
  });
  try {
    // Before the fix both missing pairs shared one unresolved id and the publish
    // rolled back on the primary key, so indexing threw before reaching here.
    const { results } = await project.service.execute("search_symbols", {
      query: "A.b",
      limit: 5,
    });
    expect(results).not.toHaveLength(0);
  } finally {
    await project.dispose();
  }
});

import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { CodebaseService } from "@codememory/application";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it, vi } from "vitest";

it("reports bounded candidates, excludes recorded consumers and updates duplicate membership", async () => {
  const db = await testDatabase();
  const body = '{ const result = "identical long business body"; return result.toUpperCase(); }';
  const f = await fixture({
    "a.ts": `function unused()${body}\nfunction second()${body}\nfunction used(){return 4}\nused();\nfunction callback(){return 5}\n[1].map(callback);\nexport function publicApi()${body}\nfunction alias(){return 6}\nexport {alias};\nfunction recursive(){return recursive()}\nclass Example { method(){return 2} }`,
  });
  try {
    const context = await createProjectContext(f.root);
    await db.store.register(context);
    const index = new IndexService(
      context,
      db.store,
      new RepositoryScanner(),
      new TypeScriptPlugin(),
    );
    await index.index();
    const isolated = await fixture({ "b.ts": `function elsewhere()${body}` });
    try {
      const other = await createProjectContext(isolated.root);
      await db.store.register(other);
      await new IndexService(
        other,
        db.store,
        new RepositoryScanner(),
        new TypeScriptPlugin(),
      ).index();
      const otherService = new CodebaseService(other, db.store);
      expect(
        (await otherService.execute("find_duplicate_code", { minBodyLength: 20 })).results,
      ).toEqual([]);
    } finally {
      await isolated.dispose();
    }
    const service = new CodebaseService(context, db.store);
    const spy = vi.spyOn(db.store, "snapshot").mockRejectedValue(new Error("No snapshots"));
    const dead = await service.execute("find_dead_code_candidates", {});
    const names = (dead.results as { symbol: { name: string } }[]).map((row) => row.symbol.name);
    expect(names).toEqual(expect.arrayContaining(["unused", "second", "recursive"]));
    for (const name of ["used", "callback", "publicApi", "alias", "method"])
      expect(names).not.toContain(name);
    expect(dead.candidateOnly).toBe(true);
    const first = await service.execute("find_duplicate_code", { minBodyLength: 20, limit: 1 });
    expect(first).toMatchObject({
      candidateOnly: true,
      hasMore: true,
      nextOffset: 1,
      results: [{ groupSize: 3 }],
    });
    const second = await service.execute("find_duplicate_code", {
      minBodyLength: 20,
      limit: 1,
      offset: 1,
    });
    expect(second.results).not.toEqual(first.results);
    expect(
      await service.execute("find_duplicate_code", { minBodyLength: 20, limit: 1, offset: 1 }),
    ).toEqual(second);
    await expect(
      service.execute("find_dead_code_candidates", { repositoryId: "other" }),
    ).rejects.toBeDefined();
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    await writeFile(
      resolve(f.root, "a.ts"),
      'function only(){return "a different body with no duplicate"}',
    );
    await index.index();
    expect((await service.execute("find_duplicate_code", { minBodyLength: 20 })).results).toEqual(
      [],
    );
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

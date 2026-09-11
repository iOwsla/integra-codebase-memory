import { rename, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import type { LanguagePlugin } from "@codememory/core";
import { IndexService, ProjectSession, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { eventually, fixture, testDatabase } from "@codememory/test-utils";
import { expect, it } from "vitest";

it("converges across repeated watcher bursts, parser failures and offline edits on restart", async () => {
  const db = await testDatabase();
  const f = await fixture({ "main.ts": "export function revision0(){return 0}" });
  const original = await createProjectContext(f.root);
  // A short reconciliation interval tests recovery without another file event.
  const c = {
    ...original,
    effectiveConfig: { ...original.effectiveConfig, debounceMs: 50, reconcileMs: 1000 },
  };
  const parser = new TypeScriptPlugin();
  let fail = false;
  const plugin: LanguagePlugin = {
    id: parser.id,
    version: parser.version,
    extensions: parser.extensions,
    analyze: (...args) => {
      if (fail) throw new Error("injected endurance failure");
      return parser.analyze(...args);
    },
  };
  const open = () =>
    new ProjectSession(
      c,
      db.store,
      new IndexService(c, db.store, new RepositoryScanner(), plugin),
      true,
      true,
    );
  let session = open();
  const converged = async (revision: number) => {
    await eventually(async () => {
      const snapshot = await db.store.snapshot(c);
      return (
        snapshot.symbols.some((s) => s.name === `revision${revision}`) &&
        snapshot.files.length === 1 &&
        snapshot.files[0]?.path === "main.ts"
      );
    }, 15000);
    const snapshot = await db.store.snapshot(c);
    expect(snapshot.symbols.filter((s) => s.kind === "FUNCTION").map((s) => s.name)).toEqual([
      `revision${revision}`,
    ]);
    const ids = new Set(snapshot.symbols.map((s) => s.id));
    expect(snapshot.edges.every((e) => ids.has(e.source) && ids.has(e.target))).toBe(true);
    return snapshot;
  };
  try {
    await session.start();
    await converged(0);
    for (let revision = 1; revision <= 12; revision++) {
      const before = await db.store.snapshot(c);
      fail = revision % 4 === 0;
      // The final graph must reflect disk state, regardless of event coalescing.
      await writeFile(resolve(f.root, "temporary.ts"), "export const transient=1");
      await rename(resolve(f.root, "temporary.ts"), resolve(f.root, "renamed.ts"));
      await writeFile(
        resolve(f.root, "main.ts"),
        `export function revision${revision}(){return ${revision}}`,
      );
      await rm(resolve(f.root, "renamed.ts"));
      if (fail) {
        await eventually(async () => (await session.status()).state === "ERROR", 15000);
        expect(await db.store.snapshot(c)).toEqual(before);
        fail = false;
        // No filesystem write: periodic reconciliation must retry the failed input.
      }
      await converged(revision);
      if (revision % 3 === 0) {
        await session.close();
        expect((await session.status()).watcher).toBe(false);
        await writeFile(resolve(f.root, "offline.ts"), "export const offline=1");
        session = open();
        await session.start();
        await eventually(async () =>
          (await db.store.snapshot(c)).symbols.some((s) => s.name === "offline"),
        );
        await rm(resolve(f.root, "offline.ts"));
        await converged(revision);
      }
    }
    await session.close();
    const final = await db.store.snapshot(c);
    const result = await new IndexService(c, db.store, new RepositoryScanner(), plugin).index();
    expect(result.reason).toBe("UNCHANGED");
    expect(result.version).toBe(final.version);
    expect((await db.store.status(c)).lastIndexJob).toMatchObject({
      state: "SUCCEEDED",
      interrupted: false,
    });
  } finally {
    await session.close();
    await f.dispose();
    await db.dispose();
  }
}, 90000);

it("retains changes queued while a previous generation is still analyzing", async () => {
  const db = await testDatabase();
  const f = await fixture({ "main.ts": "export function before(){return 0}" });
  const original = await createProjectContext(f.root);
  const c = {
    ...original,
    effectiveConfig: { ...original.effectiveConfig, debounceMs: 50, reconcileMs: 3600000 },
  };
  const parser = new TypeScriptPlugin();
  let entered = false;
  let release = () => {};
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let block = false;
  const plugin: LanguagePlugin = {
    id: parser.id,
    version: parser.version,
    extensions: parser.extensions,
    analyze: async (...args) => {
      if (block) {
        block = false;
        entered = true;
        await gate;
      }
      return parser.analyze(...args);
    },
  };
  const index = new IndexService(c, db.store, new RepositoryScanner(), plugin);
  const session = new ProjectSession(c, db.store, index, true, true);
  try {
    await session.start();
    await eventually(async () => (await session.status()).state === "READY");
    block = true;
    await writeFile(resolve(f.root, "main.ts"), "export function intermediate(){return 1}");
    await eventually(async () => entered);
    await writeFile(resolve(f.root, "main.ts"), "export function latest(){return 2}");
    await eventually(async () => (await session.status()).pendingChanges > 0);
    release();
    await eventually(async () =>
      (await db.store.snapshot(c)).symbols.some((s) => s.name === "latest"),
    );
    await session.close();
    expect((await db.store.snapshot(c)).symbols.some((s) => s.name === "intermediate")).toBe(false);
    expect((await index.index()).reason).toBe("UNCHANGED");
  } finally {
    release();
    await session.close();
    await f.dispose();
    await db.dispose();
  }
});

import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it } from "vitest";

const legacyLock =
  "SELECT pg_try_advisory_lock(hashtextextended('codememory:history-worker',0)) AS ok";
const legacyUnlock = "SELECT pg_advisory_unlock(hashtextextended('codememory:history-worker',0))";
const advisoryLocks = (pool: { query: (sql: string) => Promise<{ rows: unknown[] }> }) =>
  pool
    .query(
      "SELECT pid,mode FROM pg_locks WHERE locktype='advisory' AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) ORDER BY pid,mode",
    )
    .then((r) => r.rows as { pid: number; mode: string }[]);

it("stays exclusive with alpha.34 workers that hold the global history-worker key", async () => {
  const db = await testDatabase();
  const a = await fixture({ "a.md": "A" });
  const b = await fixture({ "b.md": "B" });
  try {
    const ca = await createProjectContext(a.root),
      cb = await createProjectContext(b.root);
    await db.store.register(ca);
    await db.store.register(cb);
    const legacy = await db.store.pool.connect();
    try {
      const pid = (await legacy.query("SELECT pg_backend_pid() AS pid")).rows[0].pid as number;
      expect((await legacy.query(legacyLock)).rows[0].ok).toBe(true);
      let ran = false;
      await expect(
        db.store.history(ca).runExclusive(async () => {
          ran = true;
        }),
      ).rejects.toMatchObject({ code: "HISTORY_BUSY" });
      expect(ran).toBe(false);
      // Only the legacy holder keeps an advisory lock; no scoped lock leaked.
      expect(await advisoryLocks(db.store.pool)).toEqual([{ pid, mode: "ExclusiveLock" }]);
      await legacy.query(legacyUnlock);

      // New workers on different projects still run at the same time.
      let release: () => void = () => {};
      const gate = new Promise<void>((r) => {
        release = r;
      });
      let entered = 0;
      const enter = async () => {
        entered++;
        if (entered === 2) release();
        await gate;
        // A legacy exclusive attempt fails while any scoped run is active.
        expect((await legacy.query(legacyLock)).rows[0].ok).toBe(false);
        return entered;
      };
      const results = await Promise.all([
        db.store.history(ca).runExclusive(enter),
        db.store.history(cb).runExclusive(enter),
      ]);
      expect(results).toEqual([2, 2]);
      expect(await advisoryLocks(db.store.pool)).toEqual([]);
    } finally {
      legacy.release();
    }
  } finally {
    await db.dispose();
    await a.dispose();
    await b.dispose();
  }
});

it("releases the shared legacy lock when the scoped lock is busy", async () => {
  const db = await testDatabase();
  const a = await fixture({ "a.md": "A" });
  try {
    const ca = await createProjectContext(a.root);
    await db.store.register(ca);
    await db.store.history(ca).runExclusive(async () => {
      await expect(db.store.history(ca).runExclusive(async () => "same")).rejects.toMatchObject({
        code: "HISTORY_BUSY",
      });
      // Only the outer run holds locks: one shared legacy and one exclusive scoped lock.
      const modes = (await advisoryLocks(db.store.pool)).map((l) => l.mode).sort();
      expect(modes).toEqual(["ExclusiveLock", "ShareLock"]);
    });
    expect(await advisoryLocks(db.store.pool)).toEqual([]);
  } finally {
    await db.dispose();
    await a.dispose();
  }
});

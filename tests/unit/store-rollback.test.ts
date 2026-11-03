import { EventEmitter } from "node:events";
import type { ProjectContext } from "@codememory/core";
import { PostgresStore } from "@codememory/database";
import type pg from "pg";
import { expect, it, vi } from "vitest";

const context = { projectScopeId: "scope" } as ProjectContext;

/**
 * A pooled client whose transaction query fails like a terminated backend (57P01) and whose
 * ROLLBACK then fails because the socket is gone.
 */
function failingPool() {
  const original = Object.assign(new Error("terminating connection due to administrator command"), {
    code: "57P01",
  });
  const client = Object.assign(new EventEmitter(), {
    release: vi.fn(),
    query: vi.fn(async (text: string) => {
      if (text.startsWith("BEGIN")) return { rows: [], rowCount: 0 };
      if (text === "ROLLBACK") throw new Error("Connection terminated unexpectedly");
      if (text.includes("schema_migrations")) return { rows: [{ version: 1000 }], rowCount: 1 };
      throw original;
    }),
  });
  const pool = Object.assign(new EventEmitter(), {
    connect: vi.fn(async () => client),
    query: vi.fn(async () => ({ rows: [{ version: 1000 }], rowCount: 1 })),
    end: vi.fn(async () => {}),
  });
  return { pool: pool as unknown as pg.Pool, client, original };
}

it("rethrows the original error when ROLLBACK fails and discards the client", async () => {
  const { pool, client, original } = failingPool();
  const store = new PostgresStore(undefined, undefined, pool);
  await expect(store.indexState(context)).rejects.toBe(original);
  expect(client.query).toHaveBeenCalledWith("ROLLBACK");
  // A client whose rollback failed is released with an error so the pool destroys it.
  expect(client.release).toHaveBeenCalledWith(expect.any(Error));
});

it("rethrows the original error from snapshot and memory saves as well", async () => {
  const { pool, original } = failingPool();
  const store = new PostgresStore(undefined, undefined, pool);
  await expect(store.snapshot(context)).rejects.toBe(original);
  await expect(
    store.saveMemory(context, {
      id: "m",
      scope: { type: "project" },
      updatedAt: new Date().toISOString(),
    } as never),
  ).rejects.toBe(original);
});

it("rethrows the original migration error when its ROLLBACK fails", async () => {
  const { pool, client, original } = failingPool();
  const store = new PostgresStore(undefined, undefined, pool);
  await expect(store.migrate()).rejects.toBe(original);
  expect(client.release).toHaveBeenCalledWith(expect.any(Error));
});

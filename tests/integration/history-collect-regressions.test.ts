import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HistoryData, ProjectContext } from "@codememory/core";
import { HistoryService } from "@codememory/history";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { afterEach, expect, it, vi } from "vitest";

const exec = promisify(execFile);
const git = (root: string, args: string[]) =>
  exec("git", ["-C", root, ...args], {
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.test",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.test",
    },
  });
async function commitAll(root: string) {
  await git(root, ["add", "-A"]);
  await git(root, ["commit", "-q", "-m", "fx"]);
}
async function finish(service: HistoryService, first: HistoryData, batchSize: number) {
  let result = first;
  for (let i = 0; i < 500 && result.state === "QUEUED"; i++)
    result = await service.collect({ batchSize, jobId: result.jobId });
  return result;
}
afterEach(() => {
  vi.restoreAllMocks();
});

const files = {
  "a.ts": "export const a = 1;",
  "b.ts": "export const b = 1;",
  "c.ts": "export const c = 1;",
  "z.ts": "export const z = 1;",
};

it("records a tracked file deleted between WIP batches as an UNSTAGED deletion", async () => {
  const db = await testDatabase();
  const f = await fixture(files);
  try {
    await git(f.root, ["init", "-q"]);
    await commitAll(f.root);
    await writeFile(join(f.root, "z.ts"), "export const z = 2;");
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const history = new HistoryService(c, db.store);
    await history.configure({ wip: true, apply: true });
    const first = await history.collect({ batchSize: 1 });
    expect(first.state).toBe("QUEUED");
    await rm(join(f.root, "z.ts"));
    const result = await finish(history, first, 1);
    expect(result.state).toBe("SUCCEEDED");
    expect(result.gaps ?? []).not.toContain("NOT_FOUND");
    const entries = (
      await db.store.pool.query(
        "SELECT layer,data->>'status' AS status FROM history_wip_entries WHERE repository_id=$1 AND path='z.ts'",
        [c.projectScopeId],
      )
    ).rows;
    expect(entries).toEqual([{ layer: "UNSTAGED", status: "DELETED" }]);
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);

it("marks the WIP cursor inconsistent when an untracked file appears mid-sweep", async () => {
  const db = await testDatabase();
  const f = await fixture(files);
  try {
    await git(f.root, ["init", "-q"]);
    await commitAll(f.root);
    await writeFile(join(f.root, "a.ts"), "export const a = 2;");
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const history = new HistoryService(c, db.store);
    await history.configure({ wip: true, apply: true });
    const first = await history.collect({ batchSize: 1 });
    expect(first.state).toBe("QUEUED");
    await writeFile(join(f.root, "new.ts"), "export const created = 1;");
    const result = await finish(history, first, 1);
    expect(result.gaps).toContain("WIP_SCOPE_CHANGED");
    const cursor = (
      await db.store.pool.query(
        "SELECT data->>'state' AS state FROM history_cursors WHERE repository_id=$1 AND stream='WIP'",
        [c.projectScopeId],
      )
    ).rows;
    expect(cursor).toEqual([{ state: "INCONSISTENT" }]);
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);

/** Captures one large WIP revision, ages it past retention and returns the excerpt total. */
async function agedWip(db: Awaited<ReturnType<typeof testDatabase>>, c: ProjectContext) {
  const history = new HistoryService(c, db.store);
  await history.configure({ wip: true, apply: true });
  await finish(history, await history.collect({ batchSize: 50 }), 50);
  await db.store.pool.query(
    "UPDATE history_revisions SET captured_at=captured_at-interval '400 days' WHERE repository_id=$1 AND origin='WIP'",
    [c.projectScopeId],
  );
  const total = Number((await db.store.history(c).stats()).excerptBytes);
  expect(total).toBeGreaterThan(10000);
  return { history, total };
}
/** Sets a budget below the configure minimum, as the existing quota tests do. */
async function budget(
  db: Awaited<ReturnType<typeof testDatabase>>,
  c: ProjectContext,
  maxStorageBytes: number,
) {
  const store = db.store.history(c);
  await store.configure({ ...(await store.settings()), maxStorageBytes });
}
const docs = {
  "docs/one.md": "# One\nUse the first rule here.",
  "docs/two.md": "# Two\nUse the second rule here.",
  "docs/three.md": "# Three\nUse the third rule here.",
};

it("does not fail an in-flight job with HISTORY_QUOTA after cleanup frees space", async () => {
  const db = await testDatabase();
  const f = await fixture({ ...files, ...docs });
  try {
    await git(f.root, ["init", "-q"]);
    await commitAll(f.root);
    await writeFile(join(f.root, "z.ts"), `export const z = "${"x".repeat(20000)}";`);
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const { history, total } = await agedWip(db, c);
    // Room for one document on top of the aged WIP excerpts, not for all three.
    await history.configure({ documents: true, wip: false, apply: true });
    await budget(db, c, total + 45);
    const first = await history.collect({ batchSize: 1 });
    expect(first.state).toBe("QUEUED");
    const cleaned = await history.cleanup(false, true);
    expect(cleaned.segments).toBeGreaterThan(0);
    const result = await finish(history, first, 1);
    expect(result).toMatchObject({ state: "SUCCEEDED" });
    expect(result.error).toBeUndefined();
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);

it("resumes automatic collection after a quota pause once cleanup frees space", async () => {
  const db = await testDatabase();
  const f = await fixture({ ...files, ...docs });
  try {
    await git(f.root, ["init", "-q"]);
    await commitAll(f.root);
    await writeFile(join(f.root, "z.ts"), `export const z = "${"x".repeat(20000)}";`);
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const { history, total } = await agedWip(db, c);
    await history.configure({ documents: true, wip: false, automatic: true, apply: true });
    await budget(db, c, total + 5);
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    await expect(history.workOnce()).rejects.toMatchObject({ code: "HISTORY_QUOTA" });
    now += 31000;
    expect(await history.workOnce()).toBe(false);
    await history.cleanup(false, true);
    now += 31000;
    expect(await history.workOnce()).toBe(true);
    const jobs = (
      await db.store.pool.query(
        "SELECT state FROM history_jobs WHERE repository_id=$1 AND kind='COLLECT' AND data->>'policyGeneration'=(SELECT policy_generation::text FROM history_settings WHERE repository_id=$1) ORDER BY created_at,id",
        [c.projectScopeId],
      )
    ).rows.map((r) => r.state);
    expect(jobs).toHaveLength(2);
    expect(jobs).toContain("FAILED");
    expect(jobs.some((s) => s === "QUEUED" || s === "SUCCEEDED")).toBe(true);
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);

it("re-walks Git history when excludeGenerated is turned off at the same HEAD", async () => {
  const db = await testDatabase();
  const f = await fixture({
    "a.ts": "export const a = 1;",
    "src/api.generated.ts": "export const api = 1;",
  });
  try {
    await git(f.root, ["init", "-q"]);
    await commitAll(f.root);
    const base = await createProjectContext(f.root);
    await db.store.register(base);
    const strict: ProjectContext = {
      ...base,
      effectiveConfig: { ...base.effectiveConfig, excludeGenerated: true },
    };
    const loose: ProjectContext = {
      ...base,
      effectiveConfig: { ...base.effectiveConfig, excludeGenerated: false },
    };
    const before = new HistoryService(strict, db.store);
    await before.configure({ git: true, apply: true });
    const first = await finish(before, await before.collect({ batchSize: 20 }), 20);
    expect(first.state).toBe("SUCCEEDED");
    const generated = async () =>
      (
        await db.store.pool.query(
          "SELECT count(*)::int AS n FROM history_revisions WHERE repository_id=$1 AND path='src/api.generated.ts'",
          [base.projectScopeId],
        )
      ).rows[0].n as number;
    expect(await generated()).toBe(0);

    const after = new HistoryService(loose, db.store);
    const job = await after.collect({ batchSize: 20 });
    expect(job.skipGit).toBe(false);
    const second = await finish(after, job, 20);
    expect(second.state).toBe("SUCCEEDED");
    expect(await generated()).toBeGreaterThan(0);
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);

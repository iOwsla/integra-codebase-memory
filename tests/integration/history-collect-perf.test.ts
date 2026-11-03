import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import type { HistoryData } from "@codememory/core";
import { HistoryService } from "@codememory/history";
import { RepositoryScanner } from "@codememory/indexer";
import { createProjectContext, GitCli } from "@codememory/shared";
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
async function collect(service: HistoryService, batchSize = 20) {
  let result: HistoryData = await service.collect({ batchSize });
  for (let i = 0; i < 500 && result.state === "QUEUED"; i++)
    result = await service.collect({ batchSize, jobId: result.jobId });
  expect(result.state).toBe("SUCCEEDED");
  return result;
}
/** Subcommand counts of every Git process started through the adapter. */
function countGit() {
  const spy = vi.spyOn(GitCli.prototype, "command");
  return (name: string, flag?: string) =>
    spy.mock.calls.filter(([, args]) => {
      const i = args.indexOf(name);
      return i >= 0 && (!flag || args.slice(i).includes(flag));
    }).length;
}
afterEach(() => {
  vi.restoreAllMocks();
});

it("keeps incremental Git collection after permanent per-file gaps", async () => {
  const db = await testDatabase();
  const f = await fixture({ "a.ts": "export const a = 1;" });
  try {
    await writeFile(join(f.root, "logo.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 1, 2]));
    await git(f.root, ["init", "-q"]);
    await commitAll(f.root);
    await writeFile(join(f.root, "a.ts"), "export const a = 2;");
    await commitAll(f.root);
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const history = new HistoryService(c, db.store);
    await history.configure({ git: true, apply: true });
    const first = await collect(history, 2);
    expect(first.gaps).toContain("SKIPPED_BINARY");
    const status = await history.status();
    expect(status.history).toMatchObject({ complete: true, blockingGapCount: 0 });
    const previous = String(status.head);

    await writeFile(join(f.root, "a.ts"), "export const a = 3;");
    await commitAll(f.root);
    const commits = vi.spyOn(GitCli.prototype, "commits");
    const second = await collect(history, 2);
    expect(commits).toHaveBeenCalled();
    for (const call of commits.mock.calls) expect(call[4]).toBe(previous);
    expect(second.excludeHead).toBe(previous);
    expect(second.commitOffset).toBe(1);
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);

it("lists, diffs, reads and discovers once per job instead of once per batch", async () => {
  const db = await testDatabase();
  const files: Record<string, string> = {};
  for (let i = 0; i < 200; i++) files[`src/file-${i}.ts`] = `export const value${i} = ${i};`;
  for (let i = 0; i < 3; i++) files[`docs/rule-${i}.md`] = `# Rule ${i}\nUse rule ${i}.`;
  const f = await fixture(files);
  try {
    await git(f.root, ["init", "-q"]);
    await commitAll(f.root);
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const history = new HistoryService(c, db.store);
    await history.configure({ documents: true, git: true, wip: true, apply: true });
    const count = countGit();
    const discover = vi.spyOn(RepositoryScanner.prototype, "discover");
    const stats = vi.spyOn(Object.getPrototypeOf(db.store.history(c)), "stats");
    const result = await collect(history, 20);
    expect(result.blockingGapCount ?? 0).toBe(0);
    expect(count("rev-list")).toBe(1);
    expect(count("diff-tree")).toBe(1);
    expect(count("show")).toBe(1);
    expect(count("cat-file")).toBe(203);
    expect(count("cat-file", "-s")).toBe(0);
    expect(count("ls-tree")).toBe(1);
    // DOCUMENTS and WIP each enumerate the worktree once.
    expect(discover).toHaveBeenCalledTimes(2);
    // The quota baseline is read when the job is created, not per batch.
    expect(stats).toHaveBeenCalledTimes(1);
    const changes = await history.search({ kind: "changes", limit: 1 });
    expect(changes.hasMore).toBe(true);
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 60000);

it("scopes the history worker lock to one project", async () => {
  const db = await testDatabase();
  const a = await fixture({ "a.md": "A" });
  const b = await fixture({ "b.md": "B" });
  try {
    const ca = await createProjectContext(a.root),
      cb = await createProjectContext(b.root);
    await db.store.register(ca);
    await db.store.register(cb);
    const result = await db.store
      .history(ca)
      .runExclusive(async () => db.store.history(cb).runExclusive(async () => "other-project"));
    expect(result).toBe("other-project");
    await expect(
      db.store
        .history(ca)
        .runExclusive(async () => db.store.history(ca).runExclusive(async () => "same")),
    ).rejects.toMatchObject({ code: "HISTORY_BUSY" });
  } finally {
    await db.dispose();
    await a.dispose();
    await b.dispose();
  }
});

it("does not add an automatic job per tick after a quota failure and prunes old collection jobs", async () => {
  const db = await testDatabase();
  const f = await fixture({ "rule.md": "# Rule\nKeep one refund service." });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const history = new HistoryService(c, db.store);
    await history.configure({ documents: true, automatic: true, apply: true });
    const store = db.store.history(c);
    await store.configure({ ...(await store.settings()), maxStorageBytes: 0 });
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    for (let tick = 0; tick < 5; tick++) {
      await history.workOnce().catch((e) => expect(e).toMatchObject({ code: "HISTORY_QUOTA" }));
      now += 31000;
    }
    const jobs = (
      await db.store.pool.query(
        "SELECT state,data->>'error' AS error FROM history_jobs WHERE repository_id=$1 AND kind='COLLECT'",
        [c.projectScopeId],
      )
    ).rows;
    expect(jobs).toEqual([{ state: "FAILED", error: "HISTORY_QUOTA" }]);
    vi.restoreAllMocks();

    await history.configure({ maxStorageBytes: 268435456, apply: true });
    await collect(history);
    await collect(history);
    await db.store.pool.query(
      "UPDATE history_jobs SET created_at=created_at-interval '10 days',updated_at=updated_at-interval '10 days' WHERE repository_id=$1",
      [c.projectScopeId],
    );
    await db.store.pool.query(
      "INSERT INTO history_jobs(repository_id,id,kind,dedupe_key,state,data,created_at,updated_at) VALUES($1,'old-interpret','INTERPRET','old-interpret','FAILED','{}',now()-interval '30 days',now()-interval '30 days')",
      [c.projectScopeId],
    );
    const before = (
      await db.store.pool.query(
        "SELECT id FROM history_jobs WHERE repository_id=$1 AND kind='COLLECT' ORDER BY created_at DESC,id DESC",
        [c.projectScopeId],
      )
    ).rows.map((r) => r.id as string);
    expect(before.length).toBe(3);
    const latest = await collect(history);
    const after = (
      await db.store.pool.query("SELECT id,kind FROM history_jobs WHERE repository_id=$1", [
        c.projectScopeId,
      ])
    ).rows;
    expect(after.map((r) => r.id).sort()).toEqual(
      [before[0], latest.jobId, "old-interpret"].sort(),
    );
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);

it("prunes a large legacy collection backlog in bounded chunks, keeping the latest per worktree", async () => {
  const db = await testDatabase();
  const f = await fixture({ "rule.md": "# Rule\nKeep one refund service." });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    // About 17 days of 30 s automatic ticks across two worktrees, all past retention.
    await db.store.pool.query(
      `INSERT INTO history_jobs(repository_id,id,kind,dedupe_key,state,data,created_at,updated_at)
SELECT $1,'legacy-'||g,'COLLECT','legacy-'||g,CASE WHEN g%3=0 THEN 'FAILED' ELSE 'SUCCEEDED' END,
jsonb_build_object('worktreeId',CASE WHEN g%2=0 THEN 'wt-a' ELSE 'wt-b' END),
now()-interval '30 days'+g*interval '1 second',now()-interval '30 days'+g*interval '1 second'
FROM generate_series(1,50000) g`,
      [c.projectScopeId],
    );
    await db.store.pool.query("ANALYZE history_jobs");
    const store = db.store.history(c);
    const started = performance.now();
    expect(await store.pruneJobs(7, 1000)).toBe(1000);
    // One chunk must stay far below the 30 s statement timeout.
    expect(performance.now() - started).toBeLessThan(5000);
    let total = 1000;
    for (let i = 0; i < 100; i++) {
      const n = await store.pruneJobs(7, 5000);
      total += n;
      if (n === 0) break;
    }
    expect(total).toBe(49998);
    const left = (
      await db.store.pool.query("SELECT id FROM history_jobs WHERE repository_id=$1 ORDER BY id", [
        c.projectScopeId,
      ])
    ).rows.map((r) => r.id);
    expect(left).toEqual(["legacy-49999", "legacy-50000"]);
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 60000);

it("starts a collection even when job pruning fails", async () => {
  const db = await testDatabase();
  const f = await fixture({ "rule.md": "# Rule\nKeep one refund service." });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const history = new HistoryService(c, db.store);
    await history.configure({ documents: true, apply: true });
    const prune = vi
      .spyOn(Object.getPrototypeOf(db.store.history(c)), "pruneJobs")
      .mockRejectedValue(Object.assign(new Error("canceling statement"), { code: "57014" }));
    const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    await collect(history);
    expect(prune).toHaveBeenCalled();
    expect(stderr.mock.calls.map(([line]) => String(line)).join("")).toContain(
      '"event":"history_job_prune_failed","code":"57014"',
    );
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);

it("treats CRLF checkouts and LFS pointers as clean WIP but still records real edits", async () => {
  const db = await testDatabase();
  const f = await fixture({
    "a.ts": "export const a = 1;\nexport const b = 2;\n",
    "b.ts": "export const b = 1;\n",
    "asset.txt": "version https://git-lfs.github.com/spec/v1\noid sha256:0000\nsize 4\n",
  });
  try {
    await git(f.root, ["init", "-q"]);
    await commitAll(f.root);
    await writeFile(join(f.root, ".gitattributes"), "*.ts text eol=crlf\n");
    await commitAll(f.root);
    await writeFile(join(f.root, "a.ts"), "export const a = 1;\r\nexport const b = 2;\r\n");
    await writeFile(join(f.root, "b.ts"), "export const b = 2;\r\n");
    await writeFile(join(f.root, "asset.txt"), "real");
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const history = new HistoryService(c, db.store);
    await history.configure({ wip: true, apply: true });
    const result = await collect(history, 2);
    expect(result.gaps).toContain("UNSUPPORTED_SOURCE");
    const rows = (await history.search({ kind: "wip", limit: 20 })).results as HistoryData[];
    expect(rows.filter((r) => r.path === "a.ts")).toEqual([]);
    expect(rows.filter((r) => r.path === "asset.txt")).toEqual([]);
    expect(rows.find((r) => r.path === "b.ts")).toMatchObject({ layer: "UNSTAGED" });
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);

it("reports deleted evidence sources as NOT_FOUND and shares one HEAD lookup per context request", async () => {
  const db = await testDatabase();
  const f = await fixture({
    "rule.md": "# Rule\nKeep one refund service.",
    "keep.md": "# Keep\nStill here.",
  });
  try {
    await git(f.root, ["init", "-q"]);
    await commitAll(f.root);
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const history = new HistoryService(c, db.store);
    await history.configure({ documents: true, apply: true });
    await collect(history);
    const segments = (await history.search({ kind: "segments", path: "rule.md" }))
      .results as HistoryData[];
    await rm(join(f.root, "rule.md"));
    const evidence = await history.evidence({ ids: [segments[0]!.id] });
    expect((evidence.results as HistoryData[])[0]?.sourceState).toBe("NOT_FOUND");
    const count = countGit();
    await history.contextFor({
      task: "refund",
      paths: ["rule.md", "keep.md", "a.ts", "b.ts", "c.ts"],
    });
    expect(count("rev-parse", "--absolute-git-dir")).toBe(1);
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);

it("requeues an interrupted interpretation without consuming an attempt", async () => {
  const db = await testDatabase();
  const f = await fixture({ "rules.md": "# Refunds\nAll refunds must use the shared service." });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const abort = new AbortController();
    const provider = {
      extract: async () => {
        abort.abort();
        throw new Error("aborted");
      },
      verify: async () => ({ output: { reviews: [] }, metrics: {} }),
    };
    const history = new HistoryService(c, db.store, provider);
    await history.configure({ documents: true, providers: true, apply: true });
    await collect(history);
    const segment = ((await history.search({ kind: "segments" })).results as HistoryData[])[0]!;
    const job = await history.submit({ batchId: "abort-1", evidenceIds: [segment.id] });
    await history.workOnce(abort.signal);
    expect(await db.store.history(c).job(String(job.jobId))).toMatchObject({
      state: "QUEUED",
      attempts: 0,
    });
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);

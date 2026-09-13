import { execFile } from "node:child_process";
import { rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { CodebaseService } from "@codememory/application";
import type { HistoryData } from "@codememory/core";
import { HistoryService } from "@codememory/history";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it } from "vitest";

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
async function collect(service: HistoryService, batchSize = 2) {
  let result: HistoryData = await service.collect({ batchSize });
  for (let i = 0; i < 100 && result.state === "QUEUED"; i++)
    result = await service.collect({ batchSize, jobId: result.jobId });
  expect(result.state).toBe("SUCCEEDED");
  return result;
}
it("collects fx file diffs with exact source, resumable batches, document revisions, isolation and no automatic promotion", async () => {
  const db = await testDatabase();
  const f = await fixture({
    "rules.md": "# Refunds\nAll refunds use the shared service.",
    "refund.ts": "export function refund(){return 1;}",
  });
  try {
    await git(f.root, ["init"]);
    await git(f.root, ["add", "."]);
    await git(f.root, ["commit", "-m", "fx"]);
    await writeFile(join(f.root, "refund.ts"), "export function refund(){return 2;}");
    await git(f.root, ["add", "."]);
    await git(f.root, ["commit", "-m", "fx"]);
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const app = new CodebaseService(c, db.store);
    await expect(app.history.collect()).rejects.toMatchObject({ code: "HISTORY_DISABLED" });
    await app.history.configure({ documents: true, git: true, apply: true });
    const result = await collect(app.history, 1);
    expect(result.gapCount ?? 0).toBe(0);
    const changes = await app.history.search({ path: "refund.ts" });
    expect((changes.results as unknown[]).length).toBe(2);
    const latest = (changes.results as HistoryData[]).find((v) => v.change_kind === "M")!;
    expect((latest.data as HistoryData).rationale).toBe("UNKNOWN");
    const after = (latest.data as HistoryData).after as HistoryData;
    const page = await app.history.search({ kind: "segments", revisionId: after.revisionId });
    const evidence = await app.history.evidence({ ids: [(page.results as HistoryData[])[0]!.id] });
    expect((evidence.results as HistoryData[])[0]).toMatchObject({
      sourceState: "UNCHANGED",
      excerpt: "export function refund(){return 2;}",
    });
    const before = await app.history.status();
    await collect(app.history);
    const repeat = await app.history.status();
    expect(repeat.revisions).toBe(before.revisions);
    expect(repeat.changes).toBe(before.changes);
    await writeFile(join(f.root, "rules.md"), "# Refunds\nRefunds must not update stock twice.");
    await collect(app.history);
    const docs = await app.history.search({ kind: "documents" });
    expect((docs.results as HistoryData[])[0]?.previous_revision_id).toBeTruthy();
    await rm(join(f.root, "rules.md"));
    await collect(app.history);
    expect(
      ((await app.history.search({ kind: "documents" })).results as HistoryData[])[0]?.state,
    ).toBe("MISSING_OR_EXCLUDED");
    expect((await app.memory.search("")).results).toEqual([]);
    await expect(
      app.history.submit({ batchId: "x", evidenceIds: ["foreign"] }),
    ).rejects.toMatchObject({ code: "HISTORY_PROVIDERS_DISABLED" });
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);
it("verifies source-neutral candidates and requires exact explicit review; invalid evidence fails closed", async () => {
  const db = await testDatabase();
  const f = await fixture({ "rules.md": "# Refunds\nAll refunds must use the shared service." });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    let invalid = false;
    const provider = {
      extract: async () => ({
        output: {
          candidates: [
            {
              id: "rule",
              claim: "The refund document requires all refunds to use the shared service.",
              classification: "REQUIREMENT",
              evidenceIds: [invalid ? "invented" : "s0"],
            },
          ],
        },
        metrics: {},
      }),
      verify: async () => ({
        output: {
          reviews: [
            {
              candidateId: "rule",
              verdict: "SUPPORTED",
              reasonCode: "SUPPORTED_BY_EVIDENCE",
              reason: "Explicit documented rule.",
              eligibleForReview: true,
            },
          ],
        },
        metrics: {},
      }),
    };
    const history = new HistoryService(c, db.store, provider);
    await history.configure({ documents: true, providers: true, apply: true });
    await collect(history);
    const segments = (await history.search({ kind: "segments" })).results as HistoryData[];
    const segment = segments.find((s) => String(s.excerpt).includes("All refunds"))!;
    const job = await history.submit({ batchId: "rule-1", evidenceIds: [segment.id] });
    expect(job.state).toBe("QUEUED");
    await history.workOnce();
    const jobData = await db.store.history(c).job(String(job.jobId));
    expect(jobData?.state).toBe("READY");
    const app = new CodebaseService(c, db.store);
    expect((await app.memory.search("")).results).toEqual([]);
    const saved = await history.review({
      jobId: job.jobId,
      candidateId: "rule",
      action: "APPROVE",
      userApproval: "Approve this exact documented refund rule.",
    });
    expect(saved.saved).toBe(true);
    expect((await app.memoryWorkflow.recall({ task: "refund" })).results).toHaveLength(1);
    expect(
      await history.review({
        jobId: job.jobId,
        candidateId: "rule",
        action: "APPROVE",
        userApproval: "Approve this exact documented refund rule.",
      }),
    ).toEqual(saved);
    invalid = true;
    const invalidJob = await history.submit({ batchId: "rule-2", evidenceIds: [segment.id] });
    await history.workOnce();
    expect(await db.store.history(c).job(String(invalidJob.jobId))).toMatchObject({
      state: "FAILED",
      data: { error: "INVALID_EVIDENCE" },
    });
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);

it("separates partial staging, deletion and untracked content, then resolves WIP after commit", async () => {
  const db = await testDatabase();
  const f = await fixture({ "x.ts": "export const x=1;", "removed.ts": "export const old=1;" });
  try {
    await git(f.root, ["init"]);
    await git(f.root, ["add", "."]);
    await git(f.root, ["commit", "-m", "fx"]);
    await writeFile(join(f.root, "x.ts"), "export const x=2;");
    await git(f.root, ["add", "x.ts"]);
    await writeFile(join(f.root, "x.ts"), "export const x=3;");
    await git(f.root, ["rm", "removed.ts"]);
    await writeFile(join(f.root, "new.ts"), "export const other=1;");
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const history = new HistoryService(c, db.store);
    await history.configure({ wip: true, apply: true });
    await collect(history, 1);
    const page = (await history.search({ kind: "wip" })).results as HistoryData[];
    expect(
      page
        .filter((e) => e.path === "x.ts")
        .map((e) => e.layer)
        .sort(),
    ).toEqual(["STAGED", "UNSTAGED"]);
    expect(page.find((e) => e.path === "removed.ts")).toMatchObject({
      layer: "STAGED",
      data: { status: "DELETED" },
    });
    expect(page.find((e) => e.path === "new.ts")).toMatchObject({ layer: "UNTRACKED" });
    await git(f.root, ["add", "."]);
    await git(f.root, ["commit", "-m", "fx"]);
    await collect(history, 1);
    expect(
      ((await history.search({ kind: "wip" })).results as HistoryData[]).every(
        (e) => e.state === "RESOLVED_RECHECK_HISTORY",
      ),
    ).toBe(true);
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);
it("handles a merge with every parent, renamed newline paths, Prisma, and explicit syntax/binary coverage", async () => {
  const db = await testDatabase();
  const f = await fixture({ "base.ts": "export const base=1;" });
  try {
    await git(f.root, ["init", "-b", "main"]);
    await git(f.root, ["add", "."]);
    await git(f.root, ["commit", "-m", "fx"]);
    await git(f.root, ["checkout", "-b", "side"]);
    await writeFile(join(f.root, "side.ts"), "export const side=1;");
    await git(f.root, ["add", "."]);
    await git(f.root, ["commit", "-m", "fx"]);
    await git(f.root, ["checkout", "main"]);
    await writeFile(join(f.root, "schema.prisma"), "/** test */\nmodel User {\n id Int @id\n}\n");
    await git(f.root, ["add", "."]);
    await git(f.root, ["commit", "-m", "fx"]);
    await git(f.root, ["merge", "--no-ff", "side", "-m", "fx"]);
    await git(f.root, ["mv", "side.ts", "renamed \nname.ts"]);
    await writeFile(join(f.root, "binary.dat"), Buffer.from([0, 1, 2]));
    await git(f.root, ["add", "."]);
    await git(f.root, ["commit", "-m", "fx"]);
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const h = new HistoryService(c, db.store);
    await h.configure({ git: true, apply: true });
    const result = await collect(h, 2);
    expect(result.gaps).toContain("SKIPPED_BINARY");
    const changes = (await h.search({ limit: 20 })).results as HistoryData[];
    expect(changes.find((v) => v.change_kind === "R")).toMatchObject({
      new_path: "renamed \nname.ts",
    });
    const prisma = changes.find((v) => v.new_path === "schema.prisma")!;
    expect(((prisma.data as HistoryData).after as HistoryData).locators).toEqual(
      expect.arrayContaining([expect.objectContaining({ name: "User", kind: "model" })]),
    );
    const merge = (
      await db.store.pool.query(
        "SELECT object_id FROM history_commits WHERE repository_id=$1 AND cardinality(parent_ids)=2",
        [c.projectScopeId],
      )
    ).rows[0].object_id;
    const parents = (
      await db.store.pool.query(
        "SELECT DISTINCT comparison_parent FROM history_file_changes WHERE repository_id=$1 AND commit_id=$2",
        [c.projectScopeId, merge],
      )
    ).rows;
    expect(parents).toHaveLength(2);
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);
it("keeps old rule evidence after document changes, flags freshness and purges exact excerpts only on request", async () => {
  const db = await testDatabase();
  const f = await fixture({ "rule.md": "Always use a shared refund service." });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const h = new HistoryService(c, db.store);
    await h.configure({ documents: true, apply: true });
    await collect(h);
    const rows = (await h.search({ kind: "segments" })).results as HistoryData[];
    const ids = rows.map((r) => r.id);
    await writeFile(
      join(f.root, "rule.md"),
      "Use a shared refund service with explicit policy parameters.",
    );
    await collect(h);
    expect(((await h.evidence({ ids })).results as HistoryData[])[0]?.sourceState).toBe("CHANGED");
    await h.cleanup(true, false);
    expect(((await h.evidence({ ids })).results as HistoryData[])[0]?.excerpt).toBeTruthy();
    await h.cleanup(true, true);
    expect(((await h.evidence({ ids })).results as HistoryData[])[0]).toMatchObject({
      excerpt: null,
      evidenceState: "SOURCE_UNAVAILABLE",
    });
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

it("restores a scoped backup with stable evidence IDs, rejects corruption and keeps providers disabled", async () => {
  const db = await testDatabase();
  const target = await testDatabase();
  const broken = await testDatabase();
  const f = await fixture({ "rule.md": "Use one refund service." });
  const output = await fixture({});
  try {
    const c = await createProjectContext(f.root);
    for (const database of [db, target, broken]) await database.store.register(c);
    const h = new HistoryService(c, db.store);
    await h.configure({ documents: true, providers: true, automatic: true, apply: true });
    await collect(h);
    const file = join(output.root, "private-history.jsonl");
    await h.backup(file);
    const restored = new HistoryService(c, target.store);
    expect((await restored.restore(file)).providersEnabled).toBe(false);
    expect((await restored.search({ kind: "segments" })).results).toEqual(
      (await h.search({ kind: "segments" })).results,
    );
    expect((await restored.status()).settings).toMatchObject({
      documents: false,
      providers: false,
      automatic: false,
    });
    const { readFile } = await import("node:fs/promises");
    const bytes = await readFile(file, "utf8");
    await writeFile(
      join(output.root, "broken.jsonl"),
      bytes.replace("Use one refund service.", "Use separate refund services."),
    );
    await expect(
      new HistoryService(c, broken.store).restore(join(output.root, "broken.jsonl")),
    ).rejects.toMatchObject({ code: "HISTORY_BACKUP_CHECKSUM" });
    expect((await broken.store.history(c).stats()).revisions).toBe(0);
  } finally {
    await db.dispose();
    await target.dispose();
    await broken.dispose();
    await f.dispose();
    await output.dispose();
  }
}, 30000);
it("marks branch-specific changes historical and preserves a captured HEAD through checkout", async () => {
  const db = await testDatabase();
  const f = await fixture({ "a.ts": "export const a=1;" });
  try {
    await git(f.root, ["init", "-b", "main"]);
    await git(f.root, ["add", "."]);
    await git(f.root, ["commit", "-m", "fx"]);
    await git(f.root, ["checkout", "-b", "side"]);
    await writeFile(join(f.root, "a.ts"), "export const a=2;");
    await git(f.root, ["add", "."]);
    await git(f.root, ["commit", "-m", "fx"]);
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const h = new HistoryService(c, db.store);
    await h.configure({ git: true, apply: true });
    await collect(h, 1);
    await git(f.root, ["checkout", "main"]);
    const rows = (await h.search({ path: "a.ts" })).results as HistoryData[];
    expect(rows.find((r) => r.change_kind === "M")).toMatchObject({
      reachableFromCurrentHead: false,
      applicability: "HISTORICAL",
      sourceState: "CHANGED",
    });
    const page = await h.collect({ batchSize: 1 });
    await git(f.root, ["checkout", "side"]);
    let state = page;
    for (let i = 0; i < 30 && state.state === "QUEUED"; i++)
      state = await h.collect({ jobId: state.jobId, batchSize: 1 });
    expect(state.head).toBe(page.head);
    expect(state.state).toBe("SUCCEEDED");
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);
it("resumes after cancellation, reports output/source limits, and refuses cross-project evidence", async () => {
  const db = await testDatabase();
  const a = await fixture({ "a.md": "A rule", "large.md": "x".repeat(2048) });
  const b = await fixture({ "b.md": "B rule" });
  try {
    const ca = await createProjectContext(a.root),
      cb = await createProjectContext(b.root);
    await db.store.register(ca);
    await db.store.register(cb);
    const aa = new HistoryService(ca, db.store),
      bb = new HistoryService(cb, db.store);
    await aa.configure({ documents: true, maxFileBytes: 1024, apply: true });
    await bb.configure({ documents: true, providers: true, apply: true });
    const abort = new AbortController();
    abort.abort();
    const paused = await aa.collect({ batchSize: 1 }, abort.signal);
    expect(paused.state).toBe("QUEUED");
    let result = paused;
    for (let i = 0; i < 10 && result.state === "QUEUED"; i++)
      result = await aa.collect({ jobId: result.jobId, batchSize: 1 });
    expect(result.gaps).toContain("SKIPPED_TOO_LARGE");
    const docs = (await aa.search({ kind: "documents" })).results as HistoryData[];
    expect(docs.find((d) => d.path === "large.md")).toMatchObject({
      data: { status: "SKIPPED_TOO_LARGE" },
    });
    const rows = (await aa.search({ kind: "segments" })).results as HistoryData[];
    await expect(
      bb.submit({ batchId: "foreign", evidenceIds: [rows[0]!.id] }),
    ).rejects.toMatchObject({ code: "INVALID_EVIDENCE" });
  } finally {
    await db.dispose();
    await a.dispose();
    await b.dispose();
  }
}, 30000);

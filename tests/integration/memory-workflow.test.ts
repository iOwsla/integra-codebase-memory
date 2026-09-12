import { CodebaseService } from "@codememory/application";
import { CodeMemoryError } from "@codememory/core";
import { type MemoryModelProvider, MemoryWorkflowService } from "@codememory/memory";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it, vi } from "vitest";

const batch = {
  sessionId: "test-session",
  batchId: "turn-1",
  messages: [
    { id: "m1", role: "user" as const, text: "Always validate refund quantities before saving." },
  ],
};
const candidate = {
  id: "c1",
  claim: "Validate refund quantities before saving.",
  classification: "REQUIREMENT",
  evidence: [{ messageId: "m1", quote: "Always validate refund quantities before saving." }],
};
const review = {
  candidateId: "c1",
  verdict: "SUPPORTED",
  reasonCode: "SUPPORTED_BY_EVIDENCE",
  reason: "The user explicitly requests validation.",
  eligibleForReview: true,
};
function provider(): MemoryModelProvider {
  return {
    extract: vi.fn(async () => ({ output: { candidates: [candidate] }, metrics: { test: true } })),
    verify: vi.fn(async () => ({ output: { reviews: [review] }, metrics: { test: true } })),
  };
}
async function setup() {
  const db = await testDatabase();
  const f = await fixture({ "src/a.ts": "export const a=1", "src-extra/b.ts": "export const b=1" });
  const c = await createProjectContext(f.root);
  await db.store.register(c);
  const p = provider();
  const workflow = new MemoryWorkflowService(c, db.store, p);
  return {
    db,
    f,
    c,
    p,
    workflow,
    dispose: async () => {
      await db.dispose();
      await f.dispose();
    },
  };
}
it("requires opt-in, deduplicates batches, persists review and promotion across restart without indexing", async () => {
  const t = await setup();
  try {
    await expect(t.workflow.submit(batch)).rejects.toMatchObject({ code: "MEMORY_DISABLED" });
    await t.workflow.configure(true);
    const job = await t.workflow.submit(batch);
    expect((await t.workflow.submit(batch)).duplicate).toBe(true);
    await expect(
      t.workflow.submit({ ...batch, messages: [{ ...batch.messages[0], text: "different" }] }),
    ).rejects.toMatchObject({ code: "EVIDENCE_CONFLICT" });
    expect(await t.workflow.workOnce()).toBe(true);
    expect(await t.db.store.memories(t.c)).toEqual([]);
    const restarted = new MemoryWorkflowService(t.c, t.db.store, t.p);
    const listed = await restarted.list({ jobId: job.jobId });
    expect(listed).toMatchObject({ job: { state: "SUCCEEDED", candidates: [{ state: "READY" }] } });
    const action = {
      jobId: job.jobId,
      candidateId: "c1",
      action: "APPROVE",
      userApproval: "User approved the displayed validation rule.",
    };
    const [a, b] = await Promise.all([restarted.review(action), restarted.review(action)]);
    expect(a.memory?.id).toBe(b.memory?.id);
    expect((await t.db.store.memories(t.c)).length).toBe(1);
    expect(await restarted.recall({ task: "refund" })).toMatchObject({
      results: [{ content: candidate.claim }],
    });
    await t.db.store.clean(t.c);
    expect((await t.db.store.memories(t.c)).length).toBe(1);
    await t.db.store.clean(t.c, true);
    await expect(restarted.list({ jobId: job.jobId })).rejects.toMatchObject({ code: "NOT_FOUND" });
  } finally {
    await t.dispose();
  }
});
it("never crosses project scope and requires explicit replacement of an active record", async () => {
  const t = await setup();
  const other = await fixture({ "b.ts": "export const b=1" });
  try {
    const c2 = await createProjectContext(other.root);
    await t.db.store.register(c2);
    const w2 = new MemoryWorkflowService(c2, t.db.store, t.p);
    await t.workflow.configure(true);
    const job = await t.workflow.submit(batch);
    await t.workflow.workOnce();
    await expect(w2.list({ jobId: job.jobId })).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      w2.review({
        jobId: job.jobId,
        candidateId: "c1",
        action: "APPROVE",
        userApproval: "Approved this exact candidate",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    expect((await w2.recall({})).results).toEqual([]);
    await expect(t.workflow.recall({ paths: ["../other"] })).rejects.toMatchObject({
      code: "PATH_OUT_OF_SCOPE",
    });
    const old = await new CodebaseService(t.c, t.db.store).memory.remember({
      type: "CONVENTION",
      title: "Old rule",
      content: "Previously accepted rule",
    });
    const result = await t.workflow.review({
      jobId: job.jobId,
      candidateId: "c1",
      action: "APPROVE",
      userApproval: "Replace the displayed old rule with this candidate",
      supersedes: old.id,
    });
    expect(result.memory?.content).toBe(candidate.claim);
    expect((await t.db.store.memories(t.c)).find((m) => m.id === old.id)?.status).toBe(
      "SUPERSEDED",
    );
  } finally {
    await other.dispose();
    await t.dispose();
  }
});
it.each([
  "invalid quote",
  "wrong classification",
  "assistant only",
  "missing review",
  "duplicate review",
])("fails closed for %s", async (kind) => {
  const t = await setup();
  try {
    await t.workflow.configure(true);
    const bad = {
      ...candidate,
      ...(kind === "invalid quote" ? { evidence: [{ messageId: "m1", quote: "invented" }] } : {}),
      ...(kind === "wrong classification" ? { classification: "EXPERIMENT_AUTHORIZATION" } : {}),
    };
    vi.mocked(t.p.extract).mockResolvedValue({ output: { candidates: [bad] }, metrics: {} });
    if (kind === "missing review")
      vi.mocked(t.p.verify).mockResolvedValue({ output: { reviews: [] }, metrics: {} });
    if (kind === "duplicate review")
      vi.mocked(t.p.verify).mockResolvedValue({
        output: { reviews: [review, review] },
        metrics: {},
      });
    const job = await t.workflow.submit(
      kind === "assistant only"
        ? { ...batch, messages: [{ ...batch.messages[0], role: "assistant" }] }
        : batch,
    );
    await t.workflow.workOnce();
    await expect(
      t.workflow.review({
        jobId: job.jobId,
        candidateId: "c1",
        action: "APPROVE",
        userApproval: "Approve this candidate",
      }),
    ).rejects.toBeDefined();
    expect(await t.db.store.memories(t.c)).toEqual([]);
  } finally {
    await t.dispose();
  }
});
it("serializes model work globally, recovers abandoned jobs, and bounds retries", async () => {
  const t = await setup();
  try {
    await t.workflow.configure(true);
    const job = await t.workflow.submit(batch);
    let release: () => void = () => {};
    let started: () => void = () => {};
    const entered = new Promise<void>((r) => {
      started = r;
    });
    vi.mocked(t.p.extract).mockImplementationOnce(async () => {
      started();
      await new Promise<void>((r) => {
        release = r;
      });
      return { output: { candidates: [candidate] }, metrics: {} };
    });
    const first = t.workflow.workOnce();
    await entered;
    expect(await new MemoryWorkflowService(t.c, t.db.store, t.p).workOnce()).toBe(false);
    release();
    await first;
    const recovered = await t.workflow.submit({ ...batch, batchId: "abandoned" });
    await t.db.store.pool.query(
      `UPDATE memory_jobs SET state='RUNNING',data=data||'{"state":"RUNNING"}'::jsonb WHERE id=$1`,
      [recovered.jobId],
    );
    expect(await t.workflow.workOnce()).toBe(true);
    expect(await t.workflow.list({ jobId: recovered.jobId })).toMatchObject({
      job: { state: "SUCCEEDED" },
    });
    vi.mocked(t.p.extract).mockRejectedValue(
      new CodeMemoryError("MEMORY_PROVIDER_TIMEOUT", "Timeout"),
    );
    const failed = await t.workflow.submit({ ...batch, batchId: "failure" });
    for (let i = 0; i < 3; i++) {
      await t.workflow.workOnce();
      if (i < 2) await t.workflow.retry(failed.jobId);
    }
    await expect(t.workflow.retry(failed.jobId)).rejects.toMatchObject({
      code: "MEMORY_RETRY_REJECTED",
    });
    expect(await t.workflow.list({ jobId: failed.jobId })).toMatchObject({
      job: { state: "FAILED", error: "MEMORY_PROVIDER_TIMEOUT", attempts: 3 },
    });
    expect(job.jobId).not.toBe(recovered.jobId);
  } finally {
    await t.dispose();
  }
});
it("bounds correction attempts and excludes directory prefix collisions in recall", async () => {
  const t = await setup();
  try {
    await t.workflow.configure(true);
    vi.mocked(t.p.verify).mockResolvedValue({
      output: {
        reviews: [
          {
            ...review,
            verdict: "CONTRADICTED",
            reasonCode: "CLASSIFICATION_MISMATCH",
            eligibleForReview: false,
          },
        ],
      },
      metrics: {},
    });
    const job = await t.workflow.submit(batch);
    await t.workflow.workOnce();
    expect(t.p.extract).toHaveBeenCalledTimes(2);
    expect(await t.workflow.list({ jobId: job.jobId })).toMatchObject({
      job: { candidates: [{ state: "NEEDS_REVIEW" }] },
    });
    const m = new CodebaseService(t.c, t.db.store).memory;
    await m.remember({ type: "CONVENTION", title: "Repo", content: "Repository rule" });
    await m.remember({
      type: "CONVENTION",
      title: "Source",
      content: "Source rule",
      scope: { type: "directory", target: "src" },
    });
    await m.remember({
      type: "CONVENTION",
      title: "Other",
      content: "Unrelated rule",
      scope: { type: "directory", target: "src-extra" },
    });
    const result = await t.workflow.recall({ paths: ["src/a.ts"] });
    expect(result.results.map((x) => x.title)).toEqual(["Source", "Repo"]);
    await t.workflow.configure(false);
    expect(await t.workflow.workOnce()).toBe(false);
  } finally {
    await t.dispose();
  }
});

it("cancels model work when the database lease is lost and never publishes stale results", async () => {
  const t = await setup();
  try {
    await t.workflow.configure(true);
    const job = await t.workflow.submit(batch);
    let entered: () => void = () => {};
    const started = new Promise<void>((r) => {
      entered = r;
    });
    vi.mocked(t.p.extract).mockImplementation(async (_input, signal) => {
      entered();
      await new Promise<void>((_resolve, reject) =>
        signal?.addEventListener(
          "abort",
          () => reject(new CodeMemoryError("MEMORY_CANCELLED", "Lease lost")),
          { once: true },
        ),
      );
      return { output: { candidates: [candidate] }, metrics: {} };
    });
    const working = t.workflow.workOnce();
    const failure = expect(working).rejects.toBeDefined();
    await started;
    const killed = await t.db.store.pool.query(
      `SELECT pg_terminate_backend(pid) FROM pg_locks WHERE locktype='advisory' AND granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database()) AND pid<>pg_backend_pid()`,
    );
    expect(killed.rowCount).toBeGreaterThan(0);
    await failure;
    expect((await t.db.store.memoryJob(t.c, job.jobId)).state).toBe("RUNNING");
    expect(await t.db.store.memories(t.c)).toEqual([]);
    vi.mocked(t.p.extract).mockResolvedValue({ output: { candidates: [candidate] }, metrics: {} });
    expect(await t.workflow.workOnce()).toBe(true);
    expect((await t.db.store.memoryJob(t.c, job.jobId)).state).toBe("SUCCEEDED");
  } finally {
    await t.dispose();
  }
});

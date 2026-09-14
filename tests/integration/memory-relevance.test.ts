import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { CodebaseService } from "@codememory/application";
import type { HistoryData } from "@codememory/core";
import { HistoryService } from "@codememory/history";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it } from "vitest";

it("recalls approved document rules by topic, evidence and checkpoint without rewriting authority", async () => {
  const db = await testDatabase();
  const f = await fixture({
    "docs/provider/rules.md": "# Provider\nProvider profiles must stay outside repositories.",
    "docs/refund/rules.md": "# Refund\nRefunds must use the shared service.",
    "src/provider/client.ts": "export const client = 1;",
  });
  const other = await fixture({ "other.md": "# Other" });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const app = new CodebaseService(c, db.store);
    const claims = [
      "Provider profiles must stay outside repositories.",
      "Refunds must use the shared service.",
    ];
    let selected = 0;
    const history = new HistoryService(c, db.store, {
      extract: async () => ({
        output: {
          candidates: [
            {
              id: "rule",
              claim: claims[selected],
              classification: "REQUIREMENT",
              evidenceIds: ["s0"],
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
              reason: "Synthetic documented requirement.",
              eligibleForReview: true,
            },
          ],
        },
        metrics: {},
      }),
    });
    await history.configure({ documents: true, providers: true, apply: true });
    let collection = await history.collect({});
    while (collection.state === "QUEUED")
      collection = await history.collect({ jobId: collection.jobId });
    const ids: string[] = [];
    for (selected = 0; selected < claims.length; selected++) {
      const segments = (await history.search({ kind: "segments", query: claims[selected] }))
        .results as HistoryData[];
      const segment = segments.find((s) => s.excerpt === claims[selected]);
      expect(segment).toBeDefined();
      const job = await history.submit({
        batchId: `relevance-${selected}`,
        evidenceIds: [segment!.id],
      });
      await history.workOnce();
      const saved = await history.review({
        jobId: job.jobId,
        candidateId: "rule",
        action: "APPROVE",
        userApproval: "Synthetic operator approves this exact fixture rule.",
      });
      ids.push(String(saved.memoryId));
    }
    const global = await app.memory.remember({
      type: "CONVENTION",
      title: "General",
      content: "Always preserve compatibility.",
    });
    const recall = async (input: unknown) =>
      (await app.memoryWorkflow.recall(input)).results.map((r) => r.id);
    expect(await recall({ task: "Investigate provider configuration changes" })).toEqual([
      ids[0],
      global.id,
    ]);
    expect(await recall({ task: "refund" })).toEqual([ids[1], global.id]);
    expect(await recall({ paths: ["docs/provider"] })).toEqual([ids[0], global.id]);
    expect(await recall({ paths: ["docs/provide"] })).toEqual([global.id]);
    expect(await recall({ task: "unrelated astronomy" })).toEqual([global.id]);
    expect(await recall({ task: "the and or" })).toEqual([global.id]);
    expect(await recall({ task: "' | ! : &" })).toEqual([global.id]);
    expect(await recall({ limit: 10 })).toHaveLength(3);
    expect((await app.memoryWorkflow.recall({ limit: 1 })).hasMore).toBe(true);
    await app.memoryWorkflow.checkpoints.capture({
      memoryId: ids[0],
      implementation: "REQUESTED",
      verification: "NOT_RUN",
      note: "Fixture source association, not implementation proof.",
      links: [{ path: "src/provider/client.ts", role: "IMPLEMENTATION" }],
    });
    expect(await recall({ paths: ["src/provider"] })).toEqual([ids[0], global.id]);
    await writeFile(
      join(f.root, "docs/provider/rules.md"),
      "# Revised plan\nInvestigate a different approach.",
    );
    // Changed evidence must stay discoverable; it does not revoke an approved rule.
    expect(await recall({ paths: ["docs/provider"] })).toEqual([ids[0], global.id]);
    const restarted = new CodebaseService(c, db.store);
    expect((await restarted.memory.search("")).results).toHaveLength(3);
    expect((await restarted.memory.search("Provider")).results[0]).toMatchObject({
      scope: { type: "repository" },
      content: claims[0],
      status: "ACTIVE",
    });
    const foreign = await createProjectContext(other.root);
    await db.store.register(foreign);
    expect(
      (await new CodebaseService(foreign, db.store).memoryWorkflow.recall({ task: "provider" }))
        .results,
    ).toEqual([]);
    await app.memory.archive(ids[0]!);
    expect(await recall({ paths: ["docs/provider"] })).toEqual([global.id]);
  } finally {
    await db.dispose();
    await f.dispose();
    await other.dispose();
  }
});

it("keeps direct scoped rules available before checkpoint and history migrations", async () => {
  const db = await testDatabase({ through: 5 });
  const f = await fixture({ "src/a.ts": "export const a = 1;" });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const app = new CodebaseService(c, db.store);
    const general = await app.memory.remember({
      type: "CONVENTION",
      title: "General",
      content: "Preserve public APIs.",
    });
    const local = await app.memory.remember({
      type: "DECISION",
      title: "Local",
      content: "Local rule",
      scope: { type: "file", target: "src/a.ts" },
    });
    expect(
      (await app.memoryWorkflow.recall({ paths: ["src/a.ts"] })).results.map((r) => r.id),
    ).toEqual([local.id, general.id]);
    expect(
      (await app.memoryWorkflow.recall({ paths: ["src/b.ts"] })).results.map((r) => r.id),
    ).toEqual([general.id]);
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

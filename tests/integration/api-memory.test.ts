import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CodebaseService } from "@codememory/application";
import { ProviderSettings } from "@codememory/memory";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it, vi } from "vitest";

it("routes document and conversation jobs through HTTP while preserving opt-in, evidence and approval", async () => {
  const directory = await mkdtemp(join(tmpdir(), "cm-api-workflow-"));
  const db = await testDatabase();
  const f = await fixture({ "rules.md": "# Rules\nRefunds must use the shared service." });
  vi.stubEnv("CODEMEMORY_PROVIDER_DIR", directory);
  vi.stubEnv("CODEMEMORY_SYNTHETIC_KEY", "not-a-real-key");
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const settings = new ProviderSettings();
    await settings.add({
      name: "pilot",
      provider: "deepseek",
      baseUrl: "https://api.deepseek.com",
      model: "deepseek-flash",
      credential: "environment",
      envName: "CODEMEMORY_SYNTHETIC_KEY",
    });
    await settings.bind(c.projectScopeId, "both", "pilot");
    let calls = 0;
    let evidenceId = "s0";
    const mock = vi.fn(async () => {
      const output =
        calls++ % 2 === 0
          ? {
              candidates: [
                {
                  id: "rule",
                  claim: "Refunds must use the shared service.",
                  classification: "REQUIREMENT",
                  evidenceIds: [evidenceId],
                },
              ],
            }
          : {
              reviews: [
                {
                  candidateId: "rule",
                  verdict: "SUPPORTED",
                  reasonCode: "SUPPORTED_BY_EVIDENCE",
                  reason: "The supplied evidence explicitly states this requirement.",
                  eligibleForReview: true,
                },
              ],
            };
      return new Response(
        JSON.stringify({
          model: "deepseek-flash",
          choices: [{ finish_reason: "stop", message: { content: JSON.stringify(output) } }],
          usage: { prompt_tokens: 1000, completion_tokens: 200 },
        }),
      );
    });
    vi.stubGlobal("fetch", mock);
    const app = new CodebaseService(c, db.store);
    await app.history.configure({ documents: true, apply: true });
    let collected = await app.history.collect({});
    while (collected.state === "QUEUED")
      collected = await app.history.collect({ jobId: collected.jobId });
    const segments = (await app.history.search({ kind: "segments" })).results as {
      id: string;
      excerpt: string;
    }[];
    const segment = segments.find((s) => s.excerpt.includes("Refunds"));
    expect(segment).toBeDefined();
    await expect(
      app.history.submit({ batchId: "doc", evidenceIds: [segment?.id] }),
    ).rejects.toMatchObject({ code: "HISTORY_PROVIDERS_DISABLED" });
    expect(mock).not.toHaveBeenCalled();
    await app.history.configure({ providers: true, apply: true });
    const doc = await app.history.submit({ batchId: "doc", evidenceIds: [segment?.id] });
    await app.history.workOnce();
    expect((await db.store.history(c).job(String(doc.jobId)))?.state).toBe("READY");
    expect((await app.memory.search("")).results).toEqual([]);
    await app.history.review({
      jobId: doc.jobId,
      candidateId: "rule",
      action: "APPROVE",
      userApproval: "Synthetic fixture explicitly approves this displayed rule.",
    });
    expect((await app.memory.search("")).results).toHaveLength(1);
    evidenceId = "m0s0";
    await app.memoryWorkflow.configure(true);
    const chat = await app.memoryWorkflow.submit({
      sessionId: "api-test",
      batchId: "chat",
      messages: [{ id: "m1", role: "user", text: "Refunds must use the shared service." }],
    });
    await app.memoryWorkflow.workOnce();
    expect(await app.memoryWorkflow.list({ jobId: chat.jobId })).toMatchObject({
      job: { state: "SUCCEEDED", candidates: [{ state: "READY" }] },
    });
    expect(await app.memoryWorkflow.status()).toMatchObject({
      models: { extractor: "deepseek-flash", verifier: "deepseek-flash" },
    });
    expect(calls).toBe(4);
    expect(Object.values((await settings.read()).usage)[0]?.requests).toBe(4);
    expect(await app.history.status()).toMatchObject({
      provider: { profile: "pilot", transport: "HTTP" },
    });
  } finally {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
    await db.dispose();
    await f.dispose();
    await rm(directory, { recursive: true, force: true });
  }
}, 30000);

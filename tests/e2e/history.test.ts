import { spawn } from "node:child_process";
import { resolve } from "node:path";
import { CodebaseService } from "@codememory/application";
import { createMcpServer } from "@codememory/mcp-server";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { Client } from "@modelcontextprotocol/client";
import { InMemoryTransport } from "@modelcontextprotocol/server";
import { expect, it } from "vitest";

const entry = resolve("apps/cli/src/index.ts");
it("uses cwd, preserves omitted settings, completes collection and inspects exact evidence from the real CLI", async () => {
  const db = await testDatabase();
  const f = await fixture({ "policy.md": "# Rule\nUse the shared refund service." });
  const run = (args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((r, reject) => {
      const child = spawn("bun", [entry, "history", ...args], {
        cwd: f.root,
        env: { ...process.env, DATABASE_URL: db.url },
      });
      let out = "",
        err = "";
      child.stdout.on("data", (b) => (out += b));
      child.stderr.on("data", (b) => (err += b));
      child.on("error", reject);
      child.on("close", (code) => r({ code, out, err }));
    });
  try {
    const preview = await run(["configure", "--documents"]);
    expect(preview.code, preview.err).toBe(0);
    expect(JSON.parse(preview.out).applied).toBe(false);
    const enable = await run(["configure", "--documents", "--yes"]);
    expect(enable.code, enable.err).toBe(0);
    const budget = await run(["configure", "--retention-days", "14", "--yes"]);
    expect(budget.code, budget.err).toBe(0);
    expect(JSON.parse(budget.out).settings.documents).toBe(true);
    const scan = await run(["scan", "--all", "--batch-size", "1"]);
    expect(scan.code, scan.err).toBe(0);
    expect(JSON.parse(scan.out).state).toBe("SUCCEEDED");
    expect(scan.err).toContain("HISTORY");
    const listed = await run(["list", "segments"]);
    expect(listed.code, listed.err).toBe(0);
    const id = JSON.parse(listed.out).results[0].id;
    const evidence = await run(["evidence", id]);
    expect(evidence.code, evidence.err).toBe(0);
    expect(JSON.parse(evidence.out).results[0].sourceState).toBe("UNCHANGED");
  } finally {
    await db.dispose();
    await f.dispose();
  }
}, 30000);
it("routes history tools to the selected project and keeps existing recall available", async () => {
  const db = await testDatabase();
  const a = await fixture({ "a.md": "# A\nUse shared refunds." });
  const b = await fixture({ "b.md": "# B\nUse separate shipments." });
  const ca = await createProjectContext(a.root),
    cb = await createProjectContext(b.root);
  await db.store.register(ca);
  await db.store.register(cb);
  const aa = new CodebaseService(ca, db.store),
    bb = new CodebaseService(cb, db.store);
  const server = createMcpServer([aa, bb]);
  const client = new Client({ name: "history-test", version: "1" });
  const [ct, st] = InMemoryTransport.createLinkedPair();
  try {
    await aa.history.configure({ documents: true, apply: true });
    await bb.history.configure({ documents: true, apply: true });
    await server.connect(st);
    await client.connect(ct);
    expect((await client.listTools()).tools.map((t) => t.name)).toEqual(
      expect.arrayContaining([
        "collect_history",
        "history_status",
        "get_history_job",
        "engineering_context",
      ]),
    );
    let response = await client.callTool({
      name: "collect_history",
      arguments: { project: ca.projectScopeId },
    });
    const job = (response.structuredContent as { jobId: string }).jobId;
    response = await client.callTool({
      name: "get_history_job",
      arguments: { project: cb.projectScopeId, jobId: job },
    });
    expect(response.isError).toBe(true);
    response = await client.callTool({
      name: "search_history",
      arguments: { project: ca.projectScopeId, kind: "segments" },
    });
    expect((response.structuredContent as { results: unknown[] }).results.length).toBeGreaterThan(
      0,
    );
    response = await client.callTool({
      name: "recall_context",
      arguments: { project: ca.projectScopeId, task: "refund" },
    });
    expect(response.isError).not.toBe(true);
  } finally {
    await client.close();
    await server.close();
    await db.dispose();
    await a.dispose();
    await b.dispose();
  }
}, 30000);

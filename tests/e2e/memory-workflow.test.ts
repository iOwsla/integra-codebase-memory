import { spawn } from "node:child_process";
import { chmod, writeFile } from "node:fs/promises";
import { delimiter, resolve } from "node:path";
import { createProjectContext } from "@codememory/shared";
import { eventually, fixture, testDatabase } from "@codememory/test-utils";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { expect, it } from "vitest";

it("runs CLI opt-in -> MCP submission -> real worker subprocesses -> review -> restart -> recall", async () => {
  const db = await testDatabase();
  const codex = `#!/usr/bin/env node
const fs=require('fs');let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const data=JSON.parse(input.trim().split('\\n').at(-1));const output={candidates:[{id:'c1',claim:'Validate refund quantities before saving.',classification:'REQUIREMENT',evidence:[{messageId:data.messages[0].id,quote:data.messages[0].text}]}]};fs.writeFileSync(process.argv[process.argv.indexOf('--output-last-message')+1],JSON.stringify(output));console.log(JSON.stringify({type:'turn.completed',usage:{input_tokens:20,output_tokens:20}}));});`;
  const claude = `#!/usr/bin/env node
let input='';process.stdin.on('data',d=>input+=d);process.stdin.on('end',()=>{const data=JSON.parse(input.trim().split('\\n').at(-1));console.log(JSON.stringify({is_error:false,modelUsage:{'claude-haiku-4-5-20251001':{inputTokens:20,outputTokens:20}},structured_output:{reviews:data.candidates.map(c=>({candidateId:c.id,verdict:'SUPPORTED',reasonCode:'SUPPORTED_BY_EVIDENCE',reason:'The request is explicit.',eligibleForReview:true}))}}));});`;
  const f = await fixture({
    "src/a.ts": "export const a=1",
    "bin/codex": codex,
    "bin/claude": claude,
    "bin/node_modules/@openai/codex/bin/codex.js": codex,
    "bin/node_modules/@anthropic-ai/claude-code/cli.js": claude,
  });
  await chmod(resolve(f.root, "bin/codex"), 0o755);
  await chmod(resolve(f.root, "bin/claude"), 0o755);
  const env = {
    ...Object.fromEntries(
      Object.entries(process.env).filter((e): e is [string, string] => typeof e[1] === "string"),
    ),
    DATABASE_URL: db.url,
    CODEMEMORY_UPDATE_CHECK: "0",
    PATH: resolve(f.root, "bin") + delimiter + process.env.PATH,
  };
  const entry = resolve("apps/cli/src/index.ts");
  const cli = (args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((r) => {
      const p = spawn("bun", [entry, ...args], { cwd: f.root, env });
      let out = "",
        err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => r({ code, out, err }));
    });
  let client: Client | undefined;
  const connect = async () => {
    const transport = new StdioClientTransport({
      command: "bun",
      args: [entry, "mcp", "--project", f.root],
      env,
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    const c = new Client({ name: "memory-e2e", version: "1" });
    await c.connect(transport);
    return c;
  };
  const data = async (c: Client, name: string, args: Record<string, unknown> = {}) => {
    const r = await c.callTool({ name, arguments: args });
    expect(r.isError).not.toBe(true);
    return JSON.parse((r.content as { text: string }[])[0]?.text ?? "null");
  };
  try {
    expect((await cli(["init"])).code).toBe(0);
    const configured = await cli(["memory", "configure", "--enable", "--yes"]);
    expect(configured.code, configured.err).toBe(0);
    client = await connect();
    const tools = await client.listTools();
    expect(tools.tools.map((t) => t.name)).toContain("recall_context");
    const queued = await data(client, "submit_memory_batch", {
      sessionId: "e2e",
      batchId: "1",
      messages: [
        { id: "m1", role: "user", text: "Always validate refund quantities before saving." },
      ],
    });
    await eventually(async () => {
      const state = await data(client as Client, "list_memory_candidates", { jobId: queued.jobId });
      return state.job.state === "SUCCEEDED";
    }, 20000);
    expect((await data(client, "search_memory")).results).toEqual([]);
    const reviewed = await data(client, "review_memory_candidate", {
      jobId: queued.jobId,
      candidateId: "c1",
      action: "APPROVE",
      userApproval: "Test operator approves this synthetic rule.",
    });
    expect(reviewed.memory.id).toBeTruthy();
    const checkpoint = await data(client, "create_memory_checkpoint", {
      memoryId: reviewed.memory.id,
      implementation: "REPORTED_IMPLEMENTED",
      note: "Synthetic source association",
      links: [{ path: "src/a.ts", role: "IMPLEMENTATION", locator: "a" }],
    });
    expect(checkpoint.checkpoint.links[0].contentHash).toHaveLength(64);
    await client.close();
    client = await connect();
    expect(
      (await data(client, "get_memory_checkpoints", { memoryId: reviewed.memory.id })).results[0]
        .sourceState,
    ).toBe("UNCHANGED");
    await writeFile(resolve(f.root, "src/a.ts"), "export const a=2");
    expect(
      (await data(client, "recall_context", { task: "refund" })).results[0].checkpoint.sourceState,
    ).toBe("RECHECK_REQUIRED");
    const checkpoints = await cli(["memory", "checkpoints", reviewed.memory.id]);
    expect(checkpoints.code, checkpoints.err).toBe(0);
    expect(JSON.parse(checkpoints.out).results[0].sourceState).toBe("RECHECK_REQUIRED");
    expect(
      (await data(client, "recall_context", { task: "refund validation" })).results[0].content,
    ).toContain("Validate refund");
    const result = await cli(["memory", "status"]);
    expect(result.code, result.err).toBe(0);
    expect(JSON.parse(result.out).enabled).toBe(true);
    const context = await createProjectContext(f.root);
    expect((await db.store.memories(context)).length).toBe(1);
  } finally {
    await client?.close();
    await db.dispose();
    await f.dispose();
  }
});

import { spawn } from "node:child_process";
import { writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { createProjectContext } from "@codememory/shared";
import { eventually, fixture, testDatabase } from "@codememory/test-utils";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const entry = resolve("apps/cli/src/index.ts");
describe("real Bun CLI and MCP STDIO", () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeAll(async () => {
    db = await testDatabase();
  });
  afterAll(async () => {
    await db?.dispose();
  });
  const cli = (args: string[]) =>
    new Promise<{ code: number | null; out: string; err: string }>((resolve) => {
      const p = spawn("bun", [entry, ...args], { env: { ...process.env, DATABASE_URL: db.url } });
      let out = "",
        err = "";
      p.stdout.on("data", (d) => (out += d));
      p.stderr.on("data", (d) => (err += d));
      p.on("close", (code) => resolve({ code, out, err }));
    });
  it("init, index, status, search, doctor work from a fresh fixture", async () => {
    const f = await fixture({
      "math.ts": "export function add(){return 1}",
      "main.ts": "import {add} from './math'; export function entry(){return add()}",
    });
    try {
      for (const cmd of [
        ["init"],
        ["index"],
        ["status"],
        ["symbol", "add"],
        ["search", "add"],
        ["doctor"],
        ["dead-code"],
        ["duplicates"],
      ]) {
        const r = await cli([...cmd, "--project", f.root]);
        expect(r.code, r.err).toBe(0);
        expect(() => JSON.parse(r.out)).not.toThrow();
      }
    } finally {
      await f.dispose();
    }
  });
  it("MCP initializes, exposes structured search/callers and rejects scope injection", async () => {
    const f = await fixture({
      "math.ts": "export function add(){return 1}",
      "main.ts": "import {add} from './math'; export function entry(){return add()}",
    });
    const transport = new StdioClientTransport({
      command: "bun",
      args: [entry, "mcp", "--project", f.root, "--auto-index", "--watch"],
      env: {
        ...Object.fromEntries(
          Object.entries(process.env).filter(
            (e): e is [string, string] => typeof e[1] === "string",
          ),
        ),
        DATABASE_URL: db.url,
      },
      stderr: "pipe",
    });
    transport.stderr?.on("data", () => {});
    const client = new Client({ name: "acceptance", version: "1.0.0" });
    try {
      await client.connect(transport);
      expect(client.getInstructions()).toContain("codebase_status");
      const tools = await client.listTools();
      expect(tools.tools.map((t) => t.name)).toEqual(
        expect.arrayContaining(["find_dead_code_candidates", "find_duplicate_code"]),
      );
      expect(tools.tools.some((t) => t.name === "search_symbols")).toBe(true);
      await eventually(async () => {
        const r = await client.callTool({ name: "codebase_status", arguments: {} });
        return Number((r.structuredContent as Record<string, unknown>)?.indexVersion) > 0;
      });
      const symbols = await client.callTool({
        name: "search_symbols",
        arguments: { query: "add" },
      });
      expect(symbols.isError).not.toBe(true);
      const rows = (symbols.structuredContent as Record<string, unknown>)?.results as {
        id: string;
        name: string;
      }[];
      expect(rows[0]?.name).toBe("add");
      const callers = await client.callTool({
        name: "find_callers",
        arguments: { symbolId: rows[0]?.id },
      });
      expect(JSON.stringify(callers.structuredContent)).toContain("entry");
      const remembered = await client.callTool({
        name: "remember",
        arguments: {
          type: "WARNING",
          title: "API rule",
          content: "explicit memory",
          tags: ["api"],
          scope: { type: "file", target: "math.ts" },
        },
      });
      expect(remembered.isError).not.toBe(true);
      const memories = await client.callTool({
        name: "search_memory",
        arguments: {
          types: ["WARNING"],
          tags: ["api"],
          scope: { type: "file", target: "math.ts" },
          limit: 1,
        },
      });
      expect(memories.isError).not.toBe(true);
      expect(memories.structuredContent).toMatchObject({
        results: [{ title: "API rule" }],
        hasMore: false,
      });
      const memoryInjection = await client.callTool({
        name: "search_memory",
        arguments: { repositoryId: "foreign" },
      });
      expect(memoryInjection.isError).toBe(true);
      const injection = await client.callTool({
        name: "search_symbols",
        arguments: { query: "add", repositoryId: "foreign" },
      });
      expect(injection.isError).toBe(true);
    } finally {
      await client.close();
      await f.dispose();
    }
  });
  it("CLI stores scoped tagged memories, filters them and preserves superseded history", async () => {
    const f = await fixture({ "src/a.ts": "export const a=1" });
    try {
      const created = await cli([
        "remember",
        "--project",
        f.root,
        "--title",
        "first",
        "--content",
        "memory text",
        "--scope",
        "file",
        "--target",
        "src/a.ts",
        "--tag",
        "api",
        "--tag",
        "stable",
      ]);
      expect(created.code, created.err).toBe(0);
      const old = JSON.parse(created.out);
      const filtered = await cli([
        "memories",
        "--project",
        f.root,
        "--scope",
        "file",
        "--target",
        "./src/a.ts",
        "--type",
        "NOTE",
        "--tag",
        "api",
        "--tag",
        "stable",
        "--limit",
        "1",
      ]);
      expect(filtered.code, filtered.err).toBe(0);
      expect(JSON.parse(filtered.out)).toMatchObject({ results: [{ id: old.id }], nextOffset: 1 });
      const replacement = await cli([
        "remember",
        "--project",
        f.root,
        "--title",
        "next",
        "--content",
        "new text",
        "--supersedes",
        old.id,
      ]);
      expect(replacement.code, replacement.err).toBe(0);
      expect(
        (await cli(["memories", "--project", f.root, "--archive", JSON.parse(replacement.out).id]))
          .code,
      ).toBe(0);
      const history = await cli(["memories", "--project", f.root, "--include-inactive"]);
      expect(history.code, history.err).toBe(0);
      expect(JSON.parse(history.out).results).toHaveLength(2);
      expect((await cli(["memories", "--project", f.root, "--limit", "1x"])).code).toBe(1);
    } finally {
      await f.dispose();
    }
  });
  it("detects a killed indexing process and reconciles its durable progress", async () => {
    const f = await fixture({ "main.ts": "export const retained=1" });
    const c = await createProjectContext(f.root);
    let child: ReturnType<typeof spawn> | undefined;
    try {
      expect((await cli(["index", "--project", f.root])).code).toBe(0);
      const script = `
        import {PostgresStore} from '@codememory/database';
        import {createProjectContext} from '@codememory/shared';
        const context=await createProjectContext(process.env.TEST_PROJECT_ROOT);
        const store=new PostgresStore();
        await store.locked(context,async(db)=>{
          const now=new Date().toISOString();
          await db.recordIndexProgress(context,{state:'RUNNING',stage:'ANALYZING',startedAt:now,updatedAt:now});
          process.stdout.write('locked');
          setInterval(()=>{},1000);
          await new Promise(()=>{});
        });`;
      child = spawn("bun", ["-e", script], {
        env: { ...process.env, DATABASE_URL: db.url, TEST_PROJECT_ROOT: f.root },
      });
      child.stderr?.resume();
      let ready = false;
      child.stdout?.on("data", () => {
        ready = true;
      });
      const exited = new Promise<void>((resolve) => child?.once("exit", () => resolve()));
      await eventually(async () => ready);
      expect((await db.store.status(c)).lastIndexJob).toMatchObject({
        state: "RUNNING",
        interrupted: false,
      });
      child.kill("SIGKILL");
      await exited;
      await eventually(
        async () =>
          !!((await db.store.status(c)).lastIndexJob as { interrupted: boolean })?.interrupted,
      );
      const result = await cli(["index", "--project", f.root]);
      expect(result.code, result.err).toBe(0);
      expect(JSON.parse(result.out).reason).toBe("UNCHANGED");
      expect((await db.store.status(c)).lastIndexJob).toMatchObject({
        state: "SUCCEEDED",
        interrupted: false,
      });
    } finally {
      if (child && child.exitCode === null) child.kill("SIGKILL");
      await f.dispose();
    }
  });
  it("missing project fails before database access", async () => {
    const r = await cli(["mcp", "--auto-index", "--watch"]);
    expect(r.code).toBe(1);
    expect(r.err).toContain("PROJECT_ROOT_REQUIRED");
    expect(r.out).toBe("");
  });
  for (const signal of ["EOF", "SIGINT", "SIGTERM"] as const)
    it(`stops watcher and releases project lock on ${signal}`, async () => {
      const f = await fixture({ "main.ts": "export const before=1" });
      const c = await createProjectContext(f.root);
      const p = spawn("bun", [entry, "mcp", "--project", f.root, "--auto-index", "--watch"], {
        env: { ...process.env, DATABASE_URL: db.url },
        stdio: ["pipe", "pipe", "pipe"],
      });
      p.stdout.resume();
      p.stderr.resume();
      const exited = new Promise<number | null>((resolve) =>
        p.once("exit", (code) => resolve(code)),
      );
      try {
        await eventually(async () => Number((await db.store.status(c)).version) > 0);
        if (signal === "EOF") p.stdin.end();
        else p.kill(signal);
        expect(
          await Promise.race([exited, new Promise((r) => setTimeout(() => r("timeout"), 5000))]),
        ).toBe(0);
        const before = (await db.store.status(c)).version;
        await writeFile(resolve(f.root, "main.ts"), "export const after=2");
        await new Promise((r) => setTimeout(r, 500));
        expect((await db.store.status(c)).version).toBe(before);
        await db.store.locked(c, async () => {});
      } finally {
        if (p.exitCode === null) p.kill("SIGKILL");
        await f.dispose();
      }
    });
});

import { execFile } from "node:child_process";
import { link, mkdir, readdir, readFile, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fixture } from "@codememory/test-utils";
import { expect, it } from "vitest";

const installer = resolve("install.sh");
const exec = promisify(execFile);
const run = (root: string, client = "both", write = true) =>
  exec("sh", [installer, "--project", root, "--client", client, ...(write ? ["--write"] : [])], {
    cwd: "/tmp",
    env: { ...process.env, DATABASE_URL: "postgresql://invalid.invalid/never-connect" },
  });

it("requires an explicit root/client and previews without creating files", async () => {
  const f = await fixture({});
  try {
    await expect(exec("sh", [installer])).rejects.toBeDefined();
    await expect(run("relative", "codex")).rejects.toBeDefined();
    await expect(run(f.root, "global")).rejects.toBeDefined();
    expect(JSON.parse((await run(f.root, "both", false)).stdout)).toMatchObject({
      applied: false,
      projectRoot: f.root,
    });
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.dispose();
  }
});

it("merges both clients, preserves other settings and instructions, and is idempotent", async () => {
  const f = await fixture({
    ".codex/config.toml":
      '# keep this comment\nmodel = "existing-model"\n[mcp_servers.other]\ncommand = "other-command"\n',
    ".mcp.json": JSON.stringify({
      note: "keep",
      mcpServers: { other: { command: "other-command", env: { SECRET: "do-not-print" } } },
    }),
    "AGENTS.md": "# Project rules\nKeep business rules.\n",
    "CLAUDE.md": "# Claude rules\nKeep these too.\n",
    ".gitignore": "node_modules/\n",
  });
  try {
    const first = await run(f.root);
    expect(first.stdout).not.toContain("do-not-print");
    const codex = await readFile(resolve(f.root, ".codex/config.toml"), "utf8");
    expect(codex).toContain('# keep this comment\nmodel = "existing-model"');
    expect(codex).toContain('[mcp_servers.other]\ncommand = "other-command"');
    const claude = JSON.parse(await readFile(resolve(f.root, ".mcp.json"), "utf8"));
    expect(claude.note).toBe("keep");
    expect(claude.mcpServers.other.env.SECRET).toBe("do-not-print");
    expect(claude.mcpServers.integra_code_memory.args).toContain(f.root);
    expect(claude.mcpServers.integra_code_memory.args).toContain("--auto-index");
    expect(await readFile(resolve(f.root, "AGENTS.md"), "utf8")).toContain("Keep business rules.");
    expect(await readFile(resolve(f.root, "CLAUDE.md"), "utf8")).toContain("@AGENTS.md");
    const paths = JSON.parse(first.stdout).changedFiles as string[];
    const before = await Promise.all(paths.map((p) => readFile(resolve(f.root, p), "utf8")));
    expect(JSON.parse((await run(f.root)).stdout).changedFiles).toEqual([]);
    expect(await Promise.all(paths.map((p) => readFile(resolve(f.root, p), "utf8")))).toEqual(
      before,
    );
  } finally {
    await f.dispose();
  }
});

it.each(["codex", "claude"])(
  "installs only the selected %s client in a nested project with spaces",
  async (client) => {
    const parent = await fixture({
      "AGENTS.md": "parent unchanged",
      "sibling/keep.ts": "export const untouched=1",
    });
    const root = resolve(parent.root, "project with spaces");
    await mkdir(root);
    try {
      await run(root, client);
      expect(await readFile(resolve(parent.root, "AGENTS.md"), "utf8")).toBe("parent unchanged");
      expect(await readdir(resolve(parent.root, "sibling"))).toEqual(["keep.ts"]);
      const names = await readdir(root);
      if (client === "codex") {
        expect(names).toContain(".codex");
        expect(names).not.toContain(".mcp.json");
        expect(names).not.toContain("CLAUDE.md");
      } else {
        expect(names).toContain(".mcp.json");
        expect(names).not.toContain(".codex");
        expect(names).not.toContain("AGENTS.md");
      }
    } finally {
      await parent.dispose();
    }
  },
);

it.each(["conflict", "markers", "malformed"])(
  "rejects %s during preflight without partial configuration writes",
  async (kind) => {
    const files: Record<string, string> =
      kind === "conflict"
        ? { ".mcp.json": '{"mcpServers":{"integra_code_memory":{"command":"different"}}}' }
        : kind === "markers"
          ? { "CLAUDE.md": "<!-- integra-code-memory:start -->\nbroken" }
          : { ".mcp.json": '{"secret":"do-not-print", broken' };
    const f = await fixture(files);
    try {
      const before = await readdir(f.root);
      try {
        await run(f.root);
        throw new Error("expected rejection");
      } catch (error) {
        expect(String((error as { stderr?: string }).stderr)).not.toContain("do-not-print");
        expect((error as { code?: number }).code).toBe(1);
      }
      expect(await readdir(f.root)).toEqual(before);
      for (const [p, contents] of Object.entries(files))
        expect(await readFile(resolve(f.root, p), "utf8")).toBe(contents);
    } finally {
      await f.dispose();
    }
  },
);

it.each(["directory", "symlink", "hardlink"])(
  "refuses redirected %s destinations",
  async (kind) => {
    const f = await fixture({}),
      outside = await fixture({ keep: "outside unchanged" });
    try {
      if (kind === "directory") await symlink(outside.root, resolve(f.root, ".codex"));
      else if (kind === "symlink")
        await symlink(resolve(outside.root, "keep"), resolve(f.root, "AGENTS.md"));
      else await link(resolve(outside.root, "keep"), resolve(f.root, "AGENTS.md"));
      await expect(run(f.root)).rejects.toBeDefined();
      expect(await readFile(resolve(outside.root, "keep"), "utf8")).toBe("outside unchanged");
      expect(await readdir(outside.root)).toEqual(["keep"]);
    } finally {
      await f.dispose();
      await outside.dispose();
    }
  },
);

it("updates an existing marked block without duplicating an AGENTS import", async () => {
  const f = await fixture({
    "AGENTS.md":
      "before\n<!-- integra-code-memory:start -->\nold rules\n<!-- integra-code-memory:end -->\nafter\n",
    "CLAUDE.md": "@AGENTS.md\n\nKeep Claude rules.\n",
  });
  try {
    await run(f.root, "claude");
    const text = await readFile(resolve(f.root, "AGENTS.md"), "utf8");
    expect(text).not.toContain("old rules");
    expect(text).toMatch(/^before\n/);
    expect(text).toMatch(/\nafter\n$/);
    expect(await readFile(resolve(f.root, "CLAUDE.md"), "utf8")).toBe(
      "@AGENTS.md\n\nKeep Claude rules.\n",
    );
    expect(JSON.parse((await run(f.root, "claude")).stdout).changedFiles).toEqual([]);
  } finally {
    await f.dispose();
  }
});

it("previews managed service connections without provisioning or exposing credentials", async () => {
  const f = await fixture({});
  try {
    const result = await exec("sh", [
      installer,
      "--project",
      f.root,
      "--client",
      "both",
      "--with-services",
    ]);
    expect(JSON.parse(result.stdout)).toMatchObject({ applied: false, servicesPlanned: true });
    expect(await readdir(f.root)).toEqual([]);
  } finally {
    await f.dispose();
  }
});

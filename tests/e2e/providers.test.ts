import { execFile } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("configures providers without a DB, requires explicit routing and never accepts a key argument", async () => {
  const root = await mkdtemp(join(tmpdir(), "cm-provider-cli-"));
  const entry = resolve("apps/cli/src/index.ts");
  const run = async (args: string[]) => {
    const result = await promisify(execFile)("bun", [entry, "providers", ...args], {
      cwd: root,
      env: { ...process.env, DATABASE_URL: "", CODEMEMORY_PROVIDER_DIR: join(root, "config") },
    });
    return JSON.parse(result.stdout);
  };
  try {
    expect((await run(["add", "pilot"])).applied).toBe(false);
    expect((await run(["status"])).profiles).toEqual([]);
    expect((await run(["add", "pilot", "--env", "TEST_API_KEY", "--yes"])).applied).toBe(true);
    await run(["use", "pilot"]);
    expect((await run(["status"])).history).toBe("cli");
    await run(["use", "pilot", "--yes"]);
    expect(await run(["status"])).toMatchObject({ history: "pilot", memory: "cli" });
    await run(["use", "cli", "--yes"]);
    expect((await run(["status"])).history).toBe("cli");
    await expect(run(["test", "pilot"])).rejects.toThrow();
    await expect(run(["login", "pilot", "--key", "not-a-real-key"])).rejects.toThrow();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}, 30000);

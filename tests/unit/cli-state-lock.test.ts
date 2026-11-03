import { spawn } from "node:child_process";
import { mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture } from "@codememory/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { installManagementCli } from "../../scripts/setup/cli-state";

afterEach(() => vi.unstubAllEnvs());

const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
async function deadPid() {
  const child = spawn("bun", ["-e", ""]);
  await new Promise((ok) => child.once("exit", ok));
  return child.pid ?? 999999;
}
/** Isolated management directory with a pre-existing update lock. */
async function lockedState(root: string, content: string) {
  const service = resolve(root, "state", "service");
  const cli = resolve(root, "state", "cli");
  await mkdir(cli, { recursive: true });
  vi.stubEnv("CODEMEMORY_SERVICE_DIR", service);
  const lock = resolve(cli, "update.lock");
  await writeFile(lock, content);
  return { cli, lock };
}

it("installs the CLI over a lock left by a dead process", async () => {
  const f = await fixture({});
  try {
    const state = await lockedState(f.root, JSON.stringify({ pid: await deadPid() }));
    const cli = await installManagementCli();
    expect(await exists(cli.executable)).toBe(true);
    expect(await exists(state.lock)).toBe(false);
    expect(JSON.parse(await readFile(resolve(state.cli, "active.json"), "utf8"))).toMatchObject({
      format: 1,
    });
  } finally {
    await f.dispose();
  }
});

it("installs the CLI over an empty lock older than the grace period", async () => {
  const f = await fixture({});
  try {
    const state = await lockedState(f.root, "");
    const old = new Date(Date.now() - 60000);
    await utimes(state.lock, old, old);
    await installManagementCli();
    expect(await exists(state.lock)).toBe(false);
  } finally {
    await f.dispose();
  }
});

it("refuses while a live process holds the lock and leaves its lock in place", async () => {
  const f = await fixture({});
  try {
    const content = JSON.stringify({ pid: process.pid, token: "other" });
    const state = await lockedState(f.root, content);
    await expect(installManagementCli()).rejects.toThrow("Another CodeMemory update is active");
    expect(await readFile(state.lock, "utf8")).toBe(content);
    expect(await exists(resolve(state.cli, "launcher.ts"))).toBe(false);
  } finally {
    await f.dispose();
  }
});

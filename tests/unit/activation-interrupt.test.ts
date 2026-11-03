import { type ChildProcess, execFile, spawn } from "node:child_process";
import { copyFile, mkdir, readFile, stat, utimes, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { fixture } from "@codememory/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeRoot } from "../../scripts/runtime-root";

const exec = promisify(execFile);
const hook = vi.hoisted(() => ({ afterAtomic: undefined as ((path: string) => void) | undefined }));
vi.mock("../../scripts/setup/cli-state", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../scripts/setup/cli-state")>();
  return {
    ...actual,
    atomic: async (path: string, content: string) => {
      await actual.atomic(path, content);
      hook.afterAtomic?.(path);
    },
  };
});
const { activateInstalledRuntime, updateLock } = await import("../../scripts/setup/activation");

afterEach(() => {
  hook.afterAtomic = undefined;
  vi.unstubAllEnvs();
});
const exists = (path: string) =>
  stat(path).then(
    () => true,
    () => false,
  );
const original = 'console.log("legacy");\n';
/** Isolated management state with verified fake releases; the first one is active. */
async function managedState(root: string, releases = 1) {
  const state = resolve(root, "state");
  const cli = resolve(state, "cli");
  const roots: string[] = [];
  for (let index = 0; index < releases; index++) {
    const release = resolve(state, "releases", `v0.1.0-alpha.${index + 1}`);
    for (const entry of ["apps/cli/src/index.ts", "scripts/managed-mcp.ts"]) {
      await mkdir(resolve(release, entry, ".."), { recursive: true });
      await writeFile(resolve(release, entry), original);
    }
    await writeFile(
      resolve(release, "package.json"),
      JSON.stringify({ name: "integra-codebase-memory", version: `0.1.0-alpha.${index + 1}` }),
    );
    await exec("git", ["init", "--quiet", release]);
    await exec("git", [
      "-C",
      release,
      "remote",
      "add",
      "origin",
      "https://github.com/iOwsla/integra-codebase-memory.git",
    ]);
    roots.push(release);
  }
  await mkdir(cli, { recursive: true });
  const active = JSON.stringify({ format: 1, root: roots[0], version: "0.1.0-alpha.1" });
  await writeFile(resolve(cli, "active.json"), active);
  return { service: resolve(state, "service"), cli, roots, active };
}
async function expectRolledBack(state: Awaited<ReturnType<typeof managedState>>) {
  expect(await exists(resolve(state.cli, "update.lock"))).toBe(false);
  expect(await readFile(resolve(state.cli, "active.json"), "utf8")).toBe(state.active);
  for (const root of state.roots)
    for (const entry of ["apps/cli/src/index.ts", "scripts/managed-mcp.ts"])
      expect(await readFile(resolve(root, entry), "utf8")).toBe(original);
  expect(await exists(resolve(state.cli, "launcher.ts"))).toBe(false);
}

it("rolls back the pointer and bridges when interrupted after the first bridge write", async () => {
  const f = await fixture({});
  try {
    const state = await managedState(f.root);
    vi.stubEnv("CODEMEMORY_SERVICE_DIR", state.service);
    const controller = new AbortController();
    hook.afterAtomic = (path) => {
      if (path.startsWith(state.roots[0] ?? "")) controller.abort();
    };
    await expect(
      activateInstalledRuntime(undefined, { signal: controller.signal }),
    ).rejects.toThrow("Activation interrupted");
    await expectRolledBack(state);
  } finally {
    await f.dispose();
  }
});

it("publishes the pointer before bridging the previously active runtime", async () => {
  const f = await fixture({});
  try {
    const state = await managedState(f.root);
    vi.stubEnv("CODEMEMORY_SERVICE_DIR", state.service);
    const order: string[] = [];
    hook.afterAtomic = (path) => order.push(path);
    const result = await activateInstalledRuntime();
    expect(result.stoppedProcesses).toEqual([]);
    expect(JSON.parse(await readFile(resolve(state.cli, "active.json"), "utf8")).root).toBe(
      runtimeRoot,
    );
    const bridge = resolve(state.roots[0] ?? "", "apps/cli/src/index.ts");
    expect(await readFile(bridge, "utf8")).toContain("CodeMemory retired entry");
    expect(order).toContain(bridge);
    expect(await exists(resolve(state.cli, "update.lock"))).toBe(false);
  } finally {
    await f.dispose();
  }
});

it("treats an empty lock as busy while fresh and as stale after the grace period", async () => {
  const f = await fixture({});
  try {
    const state = await managedState(f.root);
    vi.stubEnv("CODEMEMORY_SERVICE_DIR", state.service);
    const lock = resolve(state.cli, "update.lock");
    await writeFile(lock, "");
    await expect(updateLock(async () => "ran")).rejects.toThrow("Another CodeMemory update");
    const old = new Date(Date.now() - 60000);
    await utimes(lock, old, old);
    await expect(updateLock(async () => "ran")).resolves.toBe("ran");
    expect(await exists(lock)).toBe(false);
  } finally {
    await f.dispose();
  }
});

it("SIGINT during activate-runtime releases the lock and keeps the previous runtime", async () => {
  const f = await fixture({});
  let child: ChildProcess | undefined;
  try {
    // Several releases keep verification busy long enough to interrupt reliably.
    const state = await managedState(f.root, 12);
    child = spawn("bun", [resolve(runtimeRoot, "scripts/activate-runtime.ts")], {
      env: { ...process.env, CODEMEMORY_SERVICE_DIR: state.service, CODEMEMORY_UPDATE_CHECK: "0" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stderr = "";
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    const exited = new Promise<number | null>((ok) => child?.once("exit", (code) => ok(code)));
    const deadline = Date.now() + 15000;
    while (!(await exists(resolve(state.cli, "update.lock")))) {
      if (Date.now() > deadline || child.exitCode !== null) throw new Error("No update lock");
      await new Promise((ok) => setTimeout(ok, 5));
    }
    child.kill("SIGINT");
    expect(await exited).toBe(130);
    expect(stderr).toContain("Activation interrupted");
    await expectRolledBack(state);
  } finally {
    if (child && child.exitCode === null) child.kill("SIGKILL");
    await f.dispose();
  }
}, 30000);

/** Management directory holding the dependency-free launcher and its shared CLI entry. */
async function launcherState(root: string, entrySource: string) {
  const cli = resolve(root, "cli");
  const runtime = resolve(root, "runtime");
  await mkdir(cli, { recursive: true });
  await mkdir(resolve(runtime, "apps/cli/src"), { recursive: true });
  await copyFile(resolve(runtimeRoot, "scripts/runtime-launcher.ts"), resolve(cli, "launcher.ts"));
  await writeFile(
    resolve(cli, "mcp.ts"),
    'import { launch } from "./launcher.ts"; await launch(false);\n',
  );
  await writeFile(
    resolve(cli, "active.json"),
    JSON.stringify({ format: 1, root: runtime, version: "0.1.0-alpha.1" }),
  );
  await writeFile(resolve(runtime, "apps/cli/src/index.ts"), entrySource);
  return cli;
}
const runLauncher = (cli: string) =>
  exec("bun", [resolve(cli, "mcp.ts"), "--version"], { timeout: 15000 }).then(
    (r) => ({ code: 0, ...r }),
    (e: { code: number; stdout: string; stderr: string }) => e,
  );
async function deadPid() {
  const child = spawn("bun", ["-e", ""]);
  await new Promise((ok) => child.once("exit", ok));
  return child.pid ?? 999999;
}

it("launcher ignores a stale lock and refuses a retired active entry without spawning", async () => {
  const f = await fixture({});
  try {
    const marker = resolve(f.root, "spawned.log");
    const cli = await launcherState(
      f.root,
      `// CodeMemory retired entry: original source is in the private update backup.\nimport { appendFileSync } from "node:fs";\nappendFileSync(${JSON.stringify(marker)}, "x");\nprocess.exit(2);\n`,
    );
    await writeFile(resolve(cli, "update.lock"), JSON.stringify({ pid: await deadPid() }));
    const result = await runLauncher(cli);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("Active runtime entry is retired");
    expect(result.stderr).not.toContain("in progress");
    expect(await exists(marker)).toBe(false);
  } finally {
    await f.dispose();
  }
});

it("launcher spawns at most one child when the active entry calls back into it", async () => {
  const f = await fixture({});
  try {
    const marker = resolve(f.root, "spawned.log");
    const launcherUrl = pathToFileURL(resolve(f.root, "cli/launcher.ts")).href;
    const cli = await launcherState(
      f.root,
      // The cap keeps a regressed guard from recursing without end.
      `import { appendFileSync, readFileSync } from "node:fs";\nimport { launch } from ${JSON.stringify(launcherUrl)};\nappendFileSync(${JSON.stringify(marker)}, "x");\nif (readFileSync(${JSON.stringify(marker)}, "utf8").length > 3) process.exit(2);\nawait launch(false);\n`,
    );
    const result = await runLauncher(cli);
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain("forwards back to the launcher");
    expect(await readFile(marker, "utf8")).toBe("x");
  } finally {
    await f.dispose();
  }
});

it("launcher blocks only for a live or freshly written update lock", async () => {
  const f = await fixture({});
  try {
    const cli = await launcherState(f.root, 'console.log("launched");\n');
    const lock = resolve(cli, "update.lock");
    await writeFile(lock, JSON.stringify({ pid: process.pid, token: "t" }));
    expect((await runLauncher(cli)).stderr).toContain(`process ${process.pid}) is in progress`);
    await writeFile(lock, "");
    expect((await runLauncher(cli)).stderr).toContain("lock is being written");
    const old = new Date(Date.now() - 60000);
    await utimes(lock, old, old);
    expect((await runLauncher(cli)).stdout.trim()).toBe("launched");
  } finally {
    await f.dispose();
  }
});

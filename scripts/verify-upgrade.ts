import assert from "node:assert/strict";
import { type ChildProcess, execFile, spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, resolve } from "node:path";
import { promisify } from "node:util";
import { version } from "../package.json";
import { runtimeRoot } from "./runtime-root";

const exec = promisify(execFile);
const root = await realpath(await mkdtemp(resolve(tmpdir(), "codememory-upgrade-")));
const state = resolve(root, "state"),
  legacy = resolve(state, "releases/fresh-alpha16-test");
const env = {
  ...process.env,
  CODEMEMORY_SERVICE_DIR: resolve(state, "service"),
  CODEMEMORY_UPDATE_CHECK: "0",
  DATABASE_URL: "postgresql://invalid.invalid/no-database",
};
const children: ChildProcess[] = [];
const alive = (child: ChildProcess) => child.exitCode === null && child.signalCode === null;
const installer = resolve(runtimeRoot, "scripts/install-project.ts");
const launch = async (entry: string, project: string) => {
  const child = spawn(
    process.execPath,
    [entry, "mcp", "--project", project, "--auto-index", "--watch"],
    { env, stdio: ["ignore", "pipe", "pipe"] },
  );
  children.push(child);
  await new Promise<void>((ok, reject) => {
    const timer = setTimeout(() => reject(new Error("Fixture process did not start")), 10000);
    child.once("error", reject);
    child.stdout?.once("data", () => {
      clearTimeout(timer);
      ok();
    });
  });
  return child;
};
try {
  // The root version flag must not consume the update subcommand's version value.
  await assert.rejects(
    exec(
      process.execPath,
      [resolve(runtimeRoot, "apps/cli/src/index.ts"), "update", "--version", "invalid-tag"],
      { env },
    ),
    (error: unknown) => {
      const result = error as { stdout: string; stderr: string };
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /No verified release available/);
      return true;
    },
  );
  const a = resolve(root, "project A"),
    b = resolve(root, "project B");
  for (const project of [a, b]) {
    await mkdir(project);
    await exec(process.execPath, [installer, "--project", project, "--client", "both", "--write"], {
      env,
    });
  }
  const legacyEntry = resolve(legacy, "apps/cli/src/index.ts");
  await mkdir(dirname(legacyEntry), { recursive: true });
  await writeFile(legacyEntry, 'console.log("ready"); setInterval(() => {}, 1000);');
  await writeFile(
    resolve(legacy, "package.json"),
    JSON.stringify({ name: "integra-codebase-memory", version: "0.1.0-alpha.16" }),
  );
  await exec("git", ["init", "--quiet", legacy]);
  await exec("git", [
    "-C",
    legacy,
    "remote",
    "add",
    "origin",
    "https://github.com/iOwsla/integra-codebase-memory.git",
  ]);
  const shared = resolve(state, "cli/mcp.ts");
  for (const project of [a, b]) {
    const path = resolve(project, ".mcp.json");
    const config = JSON.parse(await readFile(path, "utf8"));
    config.mcpServers.integra_code_memory.args[0] = legacyEntry;
    config.mcpServers.other = { command: "preserve-me" };
    await writeFile(path, JSON.stringify(config));
    const toml = resolve(project, ".codex/config.toml");
    await writeFile(
      toml,
      (await readFile(toml, "utf8")).replace(JSON.stringify(shared), JSON.stringify(legacyEntry)),
    );
  }
  const activePath = resolve(state, "cli/active.json");
  await writeFile(
    activePath,
    JSON.stringify({ format: 1, root: legacy, version: "0.1.0-alpha.16" }),
  );
  const first = await launch(legacyEntry, a),
    second = await launch(legacyEntry, b);
  const otherEntry = resolve(root, "unrelated.ts");
  await writeFile(otherEntry, 'console.log("ready"); setInterval(() => {}, 1000);');
  const unrelated = await launch(otherEntry, a);
  const beforeA = await readFile(resolve(a, ".mcp.json"), "utf8");
  const pathB = resolve(b, ".mcp.json"),
    originalB = await readFile(pathB, "utf8");
  const conflict = JSON.parse(originalB);
  conflict.mcpServers.integra_code_memory.args.push("--custom");
  await writeFile(pathB, JSON.stringify(conflict));
  await assert.rejects(
    exec(
      process.execPath,
      [installer, "--project", a, "--client", "both", "--upgrade", "--write"],
      { env },
    ),
  );
  assert.equal(await readFile(resolve(a, ".mcp.json"), "utf8"), beforeA);
  assert.equal(JSON.parse(await readFile(activePath, "utf8")).version, "0.1.0-alpha.16");
  assert(
    alive(first) && alive(second) && alive(unrelated),
    "Preflight failure must not stop processes",
  );
  await writeFile(pathB, originalB);
  const upgraded = await exec(
    process.execPath,
    [installer, "--project", a, "--client", "both", "--upgrade", "--write"],
    { env, timeout: 60000 },
  );
  const result = JSON.parse(upgraded.stdout).sharedUpdate;
  assert.equal(result.activated.version, version);
  assert.equal(result.projects.length, 2);
  assert(!alive(first) && !alive(second), "Old MCP processes should stop");
  assert(alive(unrelated), "Unrelated Bun process must survive");
  for (const project of [a, b]) {
    const config = JSON.parse(await readFile(resolve(project, ".mcp.json"), "utf8"));
    assert.equal(config.mcpServers.integra_code_memory.args[0], shared);
    assert.equal(config.mcpServers.other.command, "preserve-me");
  }
  assert.equal(
    (await exec(process.execPath, [shared, "--version"], { env })).stdout.trim(),
    version,
  );
  const repeat = JSON.parse(
    (
      await exec(
        process.execPath,
        [installer, "--project", a, "--client", "both", "--upgrade", "--write"],
        { env },
      )
    ).stdout,
  );
  assert.deepEqual(repeat.changedFiles, []);
  assert.equal(
    (await exec(process.execPath, [legacyEntry, "--version"], { env })).stdout.trim(),
    version,
    "Cached legacy commands must forward to the active version",
  );
  const rollback = JSON.parse(
    await readFile(resolve(result.backupDirectory, "rollback.json"), "utf8"),
  );
  assert.equal(
    rollback.files.find((item: { path: string }) => item.path === legacyEntry).before,
    'console.log("ready"); setInterval(() => {}, 1000);',
  );
  console.log(
    JSON.stringify({
      passed: true,
      checks: [
        "two-project migration",
        "preflight is non-destructive",
        "only verified MCP processes stopped",
        "shared CLI selects active version",
        "repeat upgrade unchanged",
        "legacy cached commands redirected with originals backed up",
      ],
      platform: process.platform,
    }),
  );
} finally {
  for (const child of children) if (alive(child)) child.kill("SIGKILL");
  await Promise.all(
    children.map((child) =>
      alive(child) ? new Promise<void>((ok) => child.once("exit", () => ok())) : Promise.resolve(),
    ),
  );
  await rm(root, { recursive: true, force: true });
}

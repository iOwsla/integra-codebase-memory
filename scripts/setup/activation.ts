import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { newerRelease } from "@codememory/shared";
import { installProject } from "../install-project";
import { runtimeRoot } from "../runtime-root";
import {
  activatePointer,
  activeRuntime,
  atomic,
  installManagementCli,
  listRegistrations,
  managementDirectory,
  type Registration,
  saveRegistration,
} from "./cli-state";
import {
  managedRuntimeRoots,
  ownedProcesses,
  stopOwnedProcesses,
  verifiedRuntime,
} from "./processes";
import { checkLocalPath } from "./service-state";

export async function updateLock<T>(action: () => Promise<T>) {
  const path = resolve(managementDirectory(), "update.lock");
  await checkLocalPath(path);
  await mkdir(managementDirectory(), { recursive: true, mode: 0o700 });
  const token = JSON.stringify({ pid: process.pid, token: randomUUID() });
  try {
    await writeFile(path, token, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
    const previous = await readFile(path, "utf8");
    const owner = JSON.parse(previous);
    if (!Number.isInteger(owner.pid) || owner.pid < 1)
      throw new Error("Invalid update lock; inspect local management state");
    let alive = true;
    try {
      process.kill(owner.pid, 0);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ESRCH") alive = false;
    }
    if (alive) throw new Error("Another CodeMemory update is active; wait for it to finish");
    if ((await readFile(path, "utf8")) !== previous) throw new Error("Update lock changed; retry");
    await rm(path);
    await writeFile(path, token, { flag: "wx", mode: 0o600 });
  }
  try {
    return await action();
  } finally {
    if ((await readFile(path, "utf8").catch(() => "")) === token) await rm(path);
  }
}

/** Prepare every project before stopping processes; publish the active pointer last. */
export async function activateInstalledRuntime(selected?: Registration) {
  return updateLock(async () => {
    const registrations = await listRegistrations();
    if (selected) {
      const index = registrations.findIndex((p) => p.root === selected.root);
      if (index >= 0) registrations[index] = selected;
      else registrations.push(selected);
    }
    const present: Registration[] = [],
      skipped: string[] = [],
      disabled: string[] = [];
    for (const project of registrations) {
      if (!project.enabled) {
        disabled.push(project.root);
        continue;
      }
      if (
        await stat(project.root).then(
          (s) => s.isDirectory(),
          () => false,
        )
      )
        present.push(project);
      else skipped.push(project.root);
    }
    const plans = [];
    for (const project of present)
      plans.push({
        project,
        plan: await installProject(project.root, project.client, false, project.managed, true),
      });
    const processes = await ownedProcesses(present.map((p) => p.root));
    const beforeActive = await activeRuntime().catch(() => null);
    const manifest = JSON.parse(await readFile(resolve(runtimeRoot, "package.json"), "utf8"));
    if (
      beforeActive &&
      beforeActive.version !== manifest.version &&
      !newerRelease(manifest.version, beforeActive.version)
    )
      throw new Error("Refusing to downgrade the shared runtime");
    const backupDirectory = resolve(managementDirectory(), "updates", randomUUID());
    await mkdir(backupDirectory, { recursive: true, mode: 0o700 });
    const bridges: { path: string; content: string }[] = [];
    const releases = resolve(managementDirectory(), "../releases");
    for (const root of await managedRuntimeRoots()) {
      const within = relative(releases, root);
      if (!within || within.startsWith("..") || root === resolve(runtimeRoot)) continue;
      if (!newerRelease(manifest.version, (await verifiedRuntime(root)).version)) continue;
      for (const [entry, managed] of [
        ["apps/cli/src/index.ts", false],
        ["scripts/managed-mcp.ts", true],
      ] as const) {
        const path = resolve(root, entry);
        const content = `// CodeMemory retired entry: original source is in the private update backup.\nimport { launch } from ${JSON.stringify(pathToFileURL(resolve(managementDirectory(), "launcher.ts")).href)};\nawait launch(${managed});\n`;
        const current = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
          return null;
        });
        if (current !== null && current !== content) bridges.push({ path, content });
      }
    }
    const snapshots: { path: string; before: string | null; mode: number; after?: string }[] = [];
    const paths = plans.flatMap(({ project, plan }) =>
      plan.changedFiles.map((file) => resolve(project.root, file)),
    );
    paths.push(...bridges.map((bridge) => bridge.path));
    paths.push(
      ...[
        "launcher.ts",
        "mcp.ts",
        "managed-mcp.ts",
        process.platform === "win32" ? "bin/codememory.cmd" : "bin/codememory",
      ].map((file) => resolve(managementDirectory(), file)),
    );
    for (const path of paths) {
      await checkLocalPath(path);
      const before = await readFile(path, "utf8").catch((e: NodeJS.ErrnoException) => {
        if (e.code !== "ENOENT") throw e;
        return null;
      });
      snapshots.push({
        path,
        before,
        mode: await stat(path).then(
          (s) => s.mode & 0o777,
          () => 0o600,
        ),
      });
    }
    const onWrite = (path: string, content: string) => {
      const item = snapshots.find((s) => s.path === path);
      if (item) item.after = content;
    };
    await atomic(
      resolve(backupDirectory, "rollback.json"),
      JSON.stringify({ beforeActive, files: snapshots }),
    );
    try {
      await installManagementCli(false, onWrite);
      const results = [];
      for (const { project } of plans) {
        const result = await installProject(
          project.root,
          project.client,
          true,
          project.managed,
          true,
          onWrite,
        );
        results.push(result);
      }
      for (const bridge of bridges) {
        const expected = snapshots.find((item) => item.path === bridge.path);
        if ((await readFile(bridge.path, "utf8")) !== expected?.before)
          throw new Error("Legacy runtime changed during activation; retry");
        await atomic(bridge.path, bridge.content);
        onWrite(bridge.path, bridge.content);
      }
      // Repeat discovery after config writes to include a reconnect racing with the preflight.
      const stopping = new Map(processes.map((p) => [p.pid, p]));
      for (const candidate of await ownedProcesses(present.map((p) => p.root)))
        stopping.set(candidate.pid, candidate);
      const stopped = await stopOwnedProcesses([...stopping.values()]);
      if (selected) await saveRegistration(selected);
      await activatePointer(runtimeRoot);
      return {
        activated: { format: 1, root: runtimeRoot, version: manifest.version },
        stoppedProcesses: stopped,
        redirectedLegacyEntries: bridges.map((bridge) => bridge.path),
        projects: results,
        skippedMissingProjects: skipped,
        skippedDisabledProjects: disabled,
        backupDirectory,
        next: "Reconnect open MCP clients. Every shared project now starts the active runtime. No project was indexed by this update.",
      };
    } catch (error) {
      // Restore only our own completed writes, never overwrite a concurrent user edit.
      for (const item of snapshots.reverse())
        if (
          item.after !== undefined &&
          (await readFile(item.path, "utf8").catch(() => null)) === item.after
        ) {
          if (item.before === null) await rm(item.path);
          else {
            await atomic(item.path, item.before);
            await chmod(item.path, item.mode);
          }
        }
      throw new Error(
        `Update activation failed; previous active runtime retained. Backups: ${backupDirectory}. ${error instanceof Error ? error.message : "Retry the installer"}`,
      );
    }
  });
}

import { randomUUID } from "node:crypto";
import { chmod, mkdir, readFile, rm, stat } from "node:fs/promises";
import { relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { PostgresStore, requiredSchemaVersion } from "@codememory/database";
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
  updateLock,
} from "./cli-state";
import {
  managedRuntimeRoots,
  ownedProcesses,
  stopOwnedProcesses,
  verifiedRuntime,
} from "./processes";
import { checkLocalPath, databaseUrl, readService } from "./service-state";

export { updateLock };

/**
 * Bring the databases of the activated projects to this runtime's schema before its pointer is
 * published: the new runtime's indexing queries columns that recent migrations add. The managed
 * database is migrated in place (never via setupServices, which recreates the container and
 * cannot be rolled back). An external database is only checked, because activation must not
 * migrate a database it does not own. Migrations 10-14 are forward-compatible with alpha.34
 * (added nullable columns, dropped edge constraints that alpha.34 never relies on, a trigger
 * that fills the new columns, a partial index, a generated-flag column), so an activation that fails afterwards and keeps the old
 * runtime active on the new schema is safe.
 */
export async function migrateRuntimeDatabases(
  projects: Registration[],
  options: { managedUrl?: () => Promise<string>; externalUrl?: string } = {},
) {
  if (projects.some((p) => p.managed)) {
    const store = new PostgresStore(
      await (options.managedUrl ?? (async () => databaseUrl(await readService())))(),
    );
    try {
      await store.migrate();
    } finally {
      await store.close();
    }
  }
  if (!projects.some((p) => !p.managed)) return;
  const store = new PostgresStore(options.externalUrl);
  let version: number;
  try {
    version = await store.schemaVersion();
  } catch {
    // An unreachable external database cannot be checked here; the runtime reports
    // SCHEMA_OUTDATED on its first index instead of a raw query error.
    return "Could not check the external DATABASE_URL schema; if this release added migrations, run bun scripts/migrate.ts against it before indexing.";
  } finally {
    await store.close();
  }
  // An empty database has no CodeMemory data the new runtime could misread; the runtime
  // reports SCHEMA_OUTDATED until it is migrated, so other projects can still update.
  if (version === 0)
    return "The external DATABASE_URL has no CodeMemory schema yet; run bun scripts/migrate.ts against it before indexing.";
  if (version < requiredSchemaVersion)
    throw new Error(
      `External database schema is at migration ${version}, this release needs ${requiredSchemaVersion}. Run bun scripts/migrate.ts with that DATABASE_URL (or codememory system setup for the managed service), then retry the update.`,
    );
}

/**
 * Prepare every project before stopping processes, then publish the active pointer and only
 * afterwards retire older entries. An aborted signal rolls back at the next step boundary.
 */
export async function activateInstalledRuntime(
  selected?: Registration,
  options: { signal?: AbortSignal } = {},
) {
  const checkpoint = () => {
    if (options.signal?.aborted) throw new Error("Activation interrupted");
  };
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
    const activePath = resolve(managementDirectory(), "active.json");
    paths.push(
      activePath,
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
      checkpoint();
      await installManagementCli(false, onWrite);
      const results = [];
      for (const { project } of plans) {
        checkpoint();
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
      checkpoint();
      // Repeat discovery after config writes to include a reconnect racing with the preflight.
      const stopping = new Map(processes.map((p) => [p.pid, p]));
      for (const candidate of await ownedProcesses(present.map((p) => p.root)))
        stopping.set(candidate.pid, candidate);
      const stopped = await stopOwnedProcesses([...stopping.values()]);
      checkpoint();
      // After the old sessions stopped, so none holds a lock the migration would wait on. A
      // failure throws into the rollback below and keeps the previous pointer.
      const databaseNote = await migrateRuntimeDatabases(present);
      checkpoint();
      await activatePointer(runtimeRoot);
      onWrite(activePath, await readFile(activePath, "utf8"));
      // Bridges follow the pointer: an interruption must never leave the active root forwarding
      // back to the launcher, which would make every launch start itself again.
      for (const bridge of bridges) {
        checkpoint();
        const expected = snapshots.find((item) => item.path === bridge.path);
        if ((await readFile(bridge.path, "utf8")) !== expected?.before)
          throw new Error("Legacy runtime changed during activation; retry");
        await atomic(bridge.path, bridge.content);
        onWrite(bridge.path, bridge.content);
      }
      checkpoint();
      if (selected) await saveRegistration(selected);
      return {
        activated: { format: 1, root: runtimeRoot, version: manifest.version },
        stoppedProcesses: stopped,
        redirectedLegacyEntries: bridges.map((bridge) => bridge.path),
        projects: results,
        skippedMissingProjects: skipped,
        skippedDisabledProjects: disabled,
        backupDirectory,
        next: `Reconnect open MCP clients. Every shared project now starts the active runtime.${present.some((p) => p.managed) ? " The managed database was migrated." : ""} No project was indexed by this update.${databaseNote ? ` ${databaseNote}` : ""}`,
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

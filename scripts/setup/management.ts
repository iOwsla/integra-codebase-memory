import { resolve } from "node:path";
import { CodeMemoryError } from "@codememory/core";
import { PostgresStore } from "@codememory/database";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { ProcessTypeScriptPlugin } from "@codememory/plugin-typescript/process";
import { createProjectContext } from "@codememory/shared";
import type { Command } from "commander";
import { installProject } from "../install-project";
import {
  activeRuntime,
  installManagementCli,
  listRegistrations,
  saveRegistration,
} from "./cli-state";
import { CliProgress } from "./progress";
import { databaseUrl, readService } from "./service-state";
import { dockerExecutable, run, setupServices } from "./services";

const print = (value: unknown) => console.log(JSON.stringify(value, null, 2));
async function indexProject(root: string, managed: boolean) {
  const context = await createProjectContext(root);
  const store = new PostgresStore(managed ? databaseUrl(await readService()) : undefined);
  const progress = new CliProgress(context.canonicalRoot);
  try {
    await store.register(context);
    return await new IndexService(
      context,
      store,
      new RepositoryScanner(progress.scan),
      new ProcessTypeScriptPlugin(undefined, progress.parser),
      progress.stage,
    ).index();
  } finally {
    progress.close();
    await store.close();
  }
}
export function registerManagementCommands(cli: Command) {
  cli
    .command("update")
    .description(
      "Install a published release once, migrate registered projects and stop their old MCP processes",
    )
    .option("--version <version>", "Select a published version; downgrades are refused")
    .action(async (options) => {
      const { updateRuntime } = await import("./update");
      print(await updateRuntime(options.version));
    });
  // Management is available without opening a database or registering the current directory.
  const system = cli
    .command("system")
    .description("Manage the local runtime independently of PostgreSQL readiness");
  system.command("status").action(async () => {
    const state = await readService().then(
      (s) => ({ configured: true, port: s.port }),
      () => ({ configured: false }),
    );
    const docker = await run([dockerExecutable(), "info", "--format", "{{.OSType}}"]).catch(() => ({
      code: 1,
      out: "",
    }));
    print({
      ...state,
      dockerReady: docker.code === 0 && docker.out.trim() === "linux",
      projects: await listRegistrations(),
      activeRuntime: await activeRuntime().catch(() => null),
      next: "Use system setup --project <path> to prepare services and resume the selected project.",
    });
  });
  system.command("install-cli").action(async () => print(await installManagementCli()));
  for (const operation of ["setup", "start", "restart"]) {
    system
      .command(operation)
      .description(
        "Prepare/start managed PostgreSQL; --project resumes only that registered project",
      )
      .option(
        "--project <absolute-path>",
        "Reapply selected registration and index it after service health checks",
      )
      .action(async (options) => {
        const root = options.project
          ? (await createProjectContext(options.project)).canonicalRoot
          : undefined;
        const selected = root
          ? (await listRegistrations()).find((p) => p.root === root && p.enabled)
          : undefined;
        if (root && !selected?.managed)
          throw new Error("Select an enabled managed project from projects list.");
        if (selected) await installProject(selected.root, selected.client, false, true);
        print(await setupServices({ restart: operation === "restart" }));
        if (selected) {
          print(await installProject(selected.root, selected.client, true, true));
          print(await indexProject(selected.root, true));
        }
        if (operation === "restart")
          console.error(
            "Managed PostgreSQL restarted. Reconnect existing MCP clients if their connections failed.",
          );
      });
  }
  const projects = cli
    .command("projects")
    .description("Explicit local registrations; listing never indexes other projects");
  projects.command("list").action(async () => print(await listRegistrations()));
  projects
    .command("add [path]")
    .requiredOption("--client <client>", "codex, claude or both")
    .option("--external-db", "Use the caller's DATABASE_URL instead of managed PostgreSQL")
    .option("--upgrade", "Retarget this registered project to the shared launcher")
    .option("--no-index", "Register/configure now; defer indexing until services are ready")
    .action(async (path, options) => {
      const preview = await installProject(
        resolve(path ?? process.cwd()),
        options.client,
        false,
        !options.externalDb,
        !!options.upgrade,
      );
      await saveRegistration({
        root: preview.projectRoot,
        client: options.client,
        managed: !options.externalDb,
        enabled: true,
      });
      await installManagementCli();
      print(
        await installProject(
          preview.projectRoot,
          options.client,
          true,
          !options.externalDb,
          !!options.upgrade,
        ),
      );
      if (options.index)
        await indexProject(preview.projectRoot, !options.externalDb).then(print, () => {
          throw new Error(
            "Project is registered but indexing did not complete. Check system status, then use system setup --project <path> for managed services or index --project <path> for an external database.",
          );
        });
    });
  projects
    .command("remove [path]")
    .description("Disable registration; preserve source, index, memories and client configuration")
    .option("--yes", "Confirm disabling this project")
    .action(async (path, options) => {
      if (!options.yes)
        throw new Error("Use --yes to disable this project. Close its running MCP session first.");
      const root = resolve(path ?? process.cwd());
      const selected = (await listRegistrations()).find((p) => p.root === root);
      if (!selected)
        throw new Error("Project is not registered; use projects list to select its exact path.");
      print(await saveRegistration({ ...selected, enabled: false }));
      console.error(
        "Registration disabled. Close existing MCP sessions; future sessions will refuse this project. No source, index or memory was deleted.",
      );
    });
}
export function managementError(error: unknown) {
  return error instanceof CodeMemoryError
    ? error
    : new CodeMemoryError(
        "MANAGEMENT_ERROR",
        error instanceof Error ? error.message : "Management operation failed",
      );
}

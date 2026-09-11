import { existsSync } from "node:fs";
import { lstat, mkdir, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { PostgresStore } from "@codememory/database";
import { runtimeRoot } from "../runtime-root";
import {
  checkLocalPath,
  composeDefinition,
  composeProject,
  createService,
  databaseUrl,
  readService,
  serviceDirectory,
  volumeName,
} from "./service-state";

const here = resolve(runtimeRoot, "scripts/setup");
export type Run = (
  command: string[],
  interactive?: boolean,
) => Promise<{ code: number; out: string }>;
export const run: Run = async (command, interactive = false) => {
  const child = Bun.spawn(command, {
    env: { ...process.env },
    stdin: interactive ? "inherit" : "ignore",
    stdout: interactive ? "inherit" : "pipe",
    stderr: interactive ? "inherit" : "ignore",
  });
  const timer = setTimeout(() => child.kill(), interactive ? 900000 : 20000);
  const out = interactive ? "" : await new Response(child.stdout).text();
  const code = await child.exited;
  clearTimeout(timer);
  return { code, out };
};
export function dockerExecutable(platform: NodeJS.Platform = process.platform) {
  const candidates =
    platform === "darwin"
      ? ["/Applications/Docker.app/Contents/Resources/bin/docker"]
      : platform === "win32"
        ? [
            resolve(
              process.env.ProgramFiles || "C:/Program Files",
              "Docker/Docker/resources/bin/docker.exe",
            ),
            resolve(
              process.env.LOCALAPPDATA || ".",
              "Programs/DockerDesktop/resources/bin/docker.exe",
            ),
          ]
        : [];
  return Bun.which("docker") || candidates.find(existsSync) || "docker";
}
export async function ensureDocker(
  execute: Run = run,
  platform: NodeJS.Platform = process.platform,
) {
  if (process.env.DOCKER_HOST && !/^(unix:|npipe:)/.test(process.env.DOCKER_HOST))
    throw new Error("Managed setup refuses remote DOCKER_HOST. Select a local Docker engine.");
  let command = [dockerExecutable(platform)];
  let ready = await execute([...command, "info", "--format", "{{.OSType}}"]).catch(() => ({
    code: 1,
    out: "",
  }));
  const composeReady =
    ready.code === 0 && (await execute([...command, "compose", "version"])).code === 0;
  if (ready.code !== 0 || !composeReady) {
    console.error(
      "Preparing Docker. System password, vendor first-run prompts or a restart may be required.",
    );
    const helper =
      platform === "win32"
        ? [
            "powershell.exe",
            "-NoProfile",
            "-ExecutionPolicy",
            "Bypass",
            "-File",
            resolve(here, "ensure-docker.ps1"),
          ]
        : ["sh", resolve(here, "ensure-docker.sh")];
    if ((await execute(helper, true)).code !== 0)
      throw new Error(
        "Docker preparation is incomplete. Follow the message above and rerun the same installer; project configuration has not been applied.",
      );
    command = [dockerExecutable(platform)];
    if (platform === "linux") {
      const direct = await execute([...command, "info", "--format", "{{.OSType}}"]);
      if (direct.code !== 0) command = ["sudo", ...command];
    }
    const deadline = Date.now() + 180000;
    do {
      ready = await execute([...command, "info", "--format", "{{.OSType}}"]);
      if (ready.code === 0) break;
      await Bun.sleep(2000);
    } while (Date.now() < deadline);
  }
  if (ready.code !== 0)
    throw new Error(
      "Docker is not ready after 180 seconds. Complete Desktop setup, check virtualization/restart, then rerun.",
    );
  if (ready.out.trim() !== "linux")
    throw new Error("Select Linux containers in Docker Desktop, then rerun.");
  if ((await execute([...command, "compose", "version"])).code !== 0)
    throw new Error("Docker Compose is missing. Install its plugin and rerun.");
  const context = await execute([
    ...command,
    "context",
    "inspect",
    "--format",
    "{{.Endpoints.docker.Host}}",
  ]);
  if (context.code !== 0 || !/^(unix:|npipe:)/.test(context.out.trim()))
    throw new Error("Managed setup requires a local Docker context.");
  return command;
}
export async function setupServices(
  options: {
    directory?: string;
    execute?: Run;
    migrate?: (url: string) => Promise<void>;
    restart?: boolean;
  } = {},
) {
  const directory = options.directory || serviceDirectory();
  const execute = options.execute || run;
  const docker = await ensureDocker(execute);
  await checkLocalPath(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const lock = resolve(directory, "setup.lock");
  try {
    await mkdir(lock);
  } catch {
    throw new Error(
      "Another setup is running (setup.lock exists). If interrupted, confirm it has stopped before removing that lock and retrying.",
    );
  }
  try {
    const inspected = await execute([...docker, "volume", "ls", "--format", "{{.Name}}"]);
    if (inspected.code !== 0) throw new Error("Unable to inspect Docker volumes.");
    const existing = inspected.out.split(/\r?\n/).includes(volumeName);
    let state: Awaited<ReturnType<typeof readService>>;
    try {
      state = await readService(directory);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
      if (existing)
        throw new Error(
          "Managed volume exists without its credentials. Restore service.json; refusing to adopt or replace data.",
        );
      state = await createService(directory);
    }
    if (existing) {
      const owner = await execute([
        ...docker,
        "volume",
        "inspect",
        volumeName,
        "--format",
        '{{index .Labels "io.integra.codememory.instance"}}',
      ]);
      if (owner.code !== 0 || owner.out.trim() !== state.instance)
        throw new Error("Managed volume ownership mismatch. No migration was run.");
    }
    const containers = await execute([
      ...docker,
      "ps",
      "--all",
      "--filter",
      `label=com.docker.compose.project=${composeProject}`,
      "--format",
      "{{.ID}}",
    ]);
    if (containers.code !== 0) throw new Error("Unable to inspect managed containers.");
    for (const id of containers.out.trim().split(/\s+/).filter(Boolean)) {
      const owner = await execute([
        ...docker,
        "inspect",
        id,
        "--format",
        '{{index .Config.Labels "io.integra.codememory.instance"}}',
      ]);
      if (owner.code !== 0 || owner.out.trim() !== state.instance)
        throw new Error(
          "An unrelated container uses the managed Compose project name. No changes applied.",
        );
    }
    const compose = resolve(directory, "compose.json");
    await checkLocalPath(compose);
    const info = await lstat(compose).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (info && (!info.isFile() || info.nlink !== 1))
      throw new Error("Invalid managed Compose file.");
    await writeFile(compose, JSON.stringify(composeDefinition(state), null, 2), { mode: 0o600 });
    console.error(
      "Starting CodeMemory PostgreSQL on localhost:55433; waiting for health checks...",
    );
    const started = await execute(
      [
        ...docker,
        "compose",
        "--project-name",
        composeProject,
        "--file",
        compose,
        "up",
        "-d",
        ...(options.restart ? ["--force-recreate"] : []),
        "--wait",
        "--wait-timeout",
        "180",
      ],
      true,
    );
    if (started.code !== 0)
      throw new Error(
        "PostgreSQL startup failed. Check Docker/port 55433 and rerun. Existing volumes are preserved.",
      );
    console.error("Applying migrations only to the managed CodeMemory database...");
    if (options.migrate) await options.migrate(databaseUrl(state));
    else {
      const store = new PostgresStore(databaseUrl(state));
      try {
        await store.migrate();
      } finally {
        await store.close();
      }
    }
    return { ready: true, port: state.port, directory };
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
if (import.meta.main && process.argv[1]?.endsWith("services.ts")) {
  try {
    console.log(JSON.stringify(await setupServices()));
  } catch (e) {
    console.error(e instanceof Error ? e.message : "Managed setup failed.");
    process.exitCode = 1;
  }
}

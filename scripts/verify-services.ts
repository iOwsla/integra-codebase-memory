import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { PostgresStore } from "@codememory/database";
import {
  composeProject,
  databaseUrl,
  readService,
  serviceDirectory,
  volumeName,
} from "./setup/service-state";
import { run, setupServices } from "./setup/services";

// Disposable acceptance only: never reuse or remove an existing managed service.
const volumes = await run(["docker", "volume", "ls", "--format", "{{.Name}}"]);
const containers = await run([
  "docker",
  "ps",
  "--all",
  "--filter",
  `label=com.docker.compose.project=${composeProject}`,
  "--format",
  "{{.ID}}",
]);
if (
  volumes.code ||
  containers.code ||
  volumes.out.split(/\r?\n/).includes(volumeName) ||
  containers.out.trim()
)
  throw new Error(
    "Verification requires a local engine without an existing managed CodeMemory service.",
  );
const root = await realpath(await mkdtemp(resolve(tmpdir(), "codememory-services-")));
const previous = process.env.XDG_DATA_HOME;
process.env.XDG_DATA_HOME = root;
const directory = serviceDirectory();
try {
  await setupServices();
  const first = await readService();
  const store = new PostgresStore(databaseUrl(first));
  try {
    await store.pool.query("CREATE TABLE installer_probe(value text NOT NULL)");
    await store.pool.query("INSERT INTO installer_probe VALUES ('retained')");
  } finally {
    await store.close();
  }
  const compose = resolve(directory, "compose.json");
  const stopped = await run([
    "docker",
    "compose",
    "-p",
    composeProject,
    "-f",
    compose,
    "stop",
    "postgres",
  ]);
  if (stopped.code) throw new Error("Unable to stop disposable service for restart test.");
  await setupServices();
  const second = await readService();
  if (first.password !== second.password || first.instance !== second.instance)
    throw new Error("Managed identity changed.");
  const reopened = new PostgresStore(databaseUrl(second));
  try {
    const rows = await reopened.pool.query("SELECT value FROM installer_probe");
    if (rows.rows[0]?.value !== "retained") throw new Error("Data was lost across setup/restart.");
    const migrations = await reopened.pool.query(
      "SELECT count(*)::int AS count FROM schema_migrations",
    );
    if (migrations.rows[0]?.count < 4) throw new Error("Migrations missing.");
  } finally {
    await reopened.close();
  }
  const project = resolve(root, "project with spaces");
  await mkdir(project);
  await writeFile(resolve(project, "example.ts"), "export function sample(){return 42}\n");
  const installer = fileURLToPath(new URL("./install-project.ts", import.meta.url));
  const configured = await run(
    [
      process.execPath,
      installer,
      "--project",
      project,
      "--client",
      "both",
      "--with-services",
      "--write",
    ],
    true,
  );
  if (configured.code) throw new Error("Managed project integration failed.");
  const config = JSON.parse(await readFile(resolve(project, ".mcp.json"), "utf8"));
  const server = config.mcpServers.integra_code_memory;
  for (const command of ["index", "status"]) {
    const child = Bun.spawn([server.command, server.args[0], command, "--project", project], {
      env: {
        ...process.env,
        ...server.env,
        XDG_DATA_HOME: resolve(root, "different-gui-environment"),
        DATABASE_URL: "postgresql://application.invalid/never-connect",
      },
      stdout: "pipe",
      stderr: "pipe",
    });
    const output = await new Response(child.stdout).text();
    const error = await new Response(child.stderr).text();
    if (await child.exited)
      throw new Error(`Managed launcher ${command} failed: ${error.slice(0, 200)}`);
    if (!JSON.parse(output)) throw new Error("Missing structured result.");
  }
  console.log(
    "Managed services acceptance passed: health, migrations, persistent restart, both clients and launcher database isolation.",
  );
} finally {
  let cleanupFailed = false;
  const state = await readService().catch(() => null);
  if (state) {
    const owner = await run([
      "docker",
      "volume",
      "inspect",
      volumeName,
      "--format",
      '{{index .Labels "io.integra.codememory.instance"}}',
    ]);
    if (owner.code === 0 && owner.out.trim() === state.instance) {
      const down = await run([
        "docker",
        "compose",
        "-p",
        composeProject,
        "-f",
        resolve(directory, "compose.json"),
        "down",
        "--volumes",
      ]);
      if (down.code) {
        cleanupFailed = true;
        process.exitCode = 1;
        console.error("Disposable service cleanup failed; state preserved for recovery.");
      }
    }
  }
  if (previous === undefined) delete process.env.XDG_DATA_HOME;
  else process.env.XDG_DATA_HOME = previous;
  if (!cleanupFailed) await rm(root, { recursive: true, force: true });
}

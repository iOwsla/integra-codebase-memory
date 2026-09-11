import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { z } from "zod";
import { runtimeRoot } from "../runtime-root";
import { checkLocalPath, serviceDirectory } from "./service-state";

export const managementDirectory = () =>
  resolve(process.env.CODEMEMORY_SERVICE_DIR || serviceDirectory(), "../cli");
const registration = z
  .object({
    root: z.string(),
    client: z.enum(["codex", "claude", "both"]),
    managed: z.boolean(),
    enabled: z.boolean(),
  })
  .strict();
export type Registration = z.infer<typeof registration>;
const key = (root: string) => createHash("sha256").update(root).digest("hex");
export async function atomic(path: string, content: string) {
  await checkLocalPath(path);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temp = `${path}.${randomUUID()}.tmp`;
  try {
    await writeFile(temp, content, { flag: "wx", mode: 0o600 });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
export async function saveRegistration(value: Registration) {
  const parsed = registration.parse(value);
  await atomic(
    resolve(managementDirectory(), "projects", `${key(parsed.root)}.json`),
    JSON.stringify(parsed),
  );
  return parsed;
}
export async function listRegistrations() {
  const directory = resolve(managementDirectory(), "projects");
  await checkLocalPath(directory);
  const names = await readdir(directory).catch((e: NodeJS.ErrnoException) => {
    if (e.code !== "ENOENT") throw e;
    return [];
  });
  return Promise.all(
    names
      .filter((n) => /^[a-f0-9]{64}\.json$/.test(n))
      .map(async (name) => {
        const path = resolve(directory, name);
        await checkLocalPath(path);
        return registration.parse(JSON.parse(await readFile(path, "utf8")));
      }),
  );
}
export async function assertProjectEnabled(root: string) {
  const entry = (await listRegistrations()).find((p) => p.root === root);
  if (entry && !entry.enabled)
    throw new Error(
      "Project disabled. Use codememory projects add to enable it, then reopen its MCP session.",
    );
}
export const sharedEntry = (managed = false) =>
  resolve(managementDirectory(), managed ? "managed-mcp.ts" : "mcp.ts");
export async function activeRuntime() {
  const path = resolve(managementDirectory(), "active.json");
  await checkLocalPath(path);
  return JSON.parse(await readFile(path, "utf8")) as {
    format: number;
    root: string;
    version: string;
  };
}
export async function activatePointer(root: string) {
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  await atomic(
    resolve(managementDirectory(), "active.json"),
    JSON.stringify({ format: 1, root, version: manifest.version }),
  );
}
/** Install the stable dispatcher before Docker/WSL can request a reboot. */
export async function installManagementCli(
  activate = true,
  onWrite?: (path: string, content: string) => void,
) {
  if (activate) {
    if (
      await readFile(resolve(managementDirectory(), "update.lock"), "utf8").then(
        () => true,
        (e: NodeJS.ErrnoException) => {
          if (e.code !== "ENOENT") throw e;
          return false;
        },
      )
    )
      throw new Error("Another CodeMemory update is active; wait before changing shared launchers");
    const current = await activeRuntime().catch(() => null);
    const manifest = JSON.parse(await readFile(resolve(runtimeRoot, "package.json"), "utf8"));
    if (current && current.version !== manifest.version)
      throw new Error(
        "Shared runtime has a different version. Use codememory update or bootstrap --upgrade.",
      );
  }
  const write = async (path: string, content: string) => {
    await atomic(path, content);
    onWrite?.(path, content);
  };
  const directory = resolve(managementDirectory(), "bin");
  await write(
    resolve(managementDirectory(), "launcher.ts"),
    await readFile(resolve(runtimeRoot, "scripts/runtime-launcher.ts"), "utf8"),
  );
  for (const managed of [false, true])
    await write(
      sharedEntry(managed),
      `import { launch } from "./launcher.ts"; await launch(${managed});\n`,
    );
  if (activate) await activatePointer(runtimeRoot);
  const entry = sharedEntry();
  const executable = process.execPath;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const path = resolve(directory, process.platform === "win32" ? "codememory.cmd" : "codememory");
  if (process.platform === "win32") {
    // CMD expands percent expressions even inside quotes. Refuse unsafe paths.
    if (/[\r\n%"!]/.test(executable + entry))
      throw new Error("CLI paths contain unsupported Windows command characters.");
    await write(path, `@echo off\r\n"${executable}" "${entry}" %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    await write(path, `#!/bin/sh\nexec ${quote(executable)} ${quote(entry)} "$@"\n`);
    await chmod(path, 0o700);
  }
  console.error(
    `Management CLI installed: ${path}\nAdd ${directory} to your user PATH, or invoke this absolute path. After a reboot use: codememory system setup --project <absolute-project-path>`,
  );
  return { executable: path, pathDirectory: directory };
}

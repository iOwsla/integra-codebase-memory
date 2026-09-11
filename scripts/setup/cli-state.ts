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
async function atomic(path: string, content: string) {
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
/** Install a user-local executable before Docker/WSL can request a reboot. */
export async function installManagementCli() {
  const directory = resolve(managementDirectory(), "bin");
  const entry = resolve(runtimeRoot, "apps/cli/src/index.ts");
  const executable = process.execPath;
  const quote = (value: string) => `'${value.replaceAll("'", "'\\''")}'`;
  const path = resolve(directory, process.platform === "win32" ? "codememory.cmd" : "codememory");
  if (process.platform === "win32") {
    // CMD expands percent expressions even inside quotes. Refuse unsafe paths.
    if (/[\r\n%"!]/.test(executable + entry))
      throw new Error("CLI paths contain unsupported Windows command characters.");
    await atomic(path, `@echo off\r\n"${executable}" "${entry}" %*\r\nexit /b %errorlevel%\r\n`);
  } else {
    await atomic(path, `#!/bin/sh\nexec ${quote(executable)} ${quote(entry)} "$@"\n`);
    await chmod(path, 0o700);
  }
  console.error(
    `Management CLI installed: ${path}\nAdd ${directory} to your user PATH, or invoke this absolute path. After a reboot use: codememory system setup --project <absolute-project-path>`,
  );
  return { executable: path, pathDirectory: directory };
}

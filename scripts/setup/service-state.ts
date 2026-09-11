import { randomBytes, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { dirname, isAbsolute, resolve } from "node:path";
import { z } from "zod";

export const serviceSchema = z
  .object({
    format: z.literal(1),
    instance: z.string().uuid(),
    password: z.string().regex(/^[a-f0-9]{64}$/),
    port: z.literal(55433),
  })
  .strict();
export type ServiceState = z.infer<typeof serviceSchema>;
export function serviceDirectory() {
  const base =
    process.platform === "win32"
      ? process.env.LOCALAPPDATA
      : process.env.XDG_DATA_HOME || resolve(homedir(), ".local/share");
  if (!base || !isAbsolute(base))
    throw new Error("A local absolute user data directory is required.");
  return resolve(base, "integra-code-memory/service");
}
export async function checkLocalPath(path: string) {
  let cursor = resolve(path);
  while (true) {
    const info = await lstat(cursor).catch((e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return null;
    });
    if (info?.isSymbolicLink())
      throw new Error("Managed service paths must not be symbolic links or junctions.");
    if (cursor === dirname(cursor)) break;
    cursor = dirname(cursor);
  }
}
export async function readService(directory = serviceDirectory()) {
  const path = resolve(directory, "service.json");
  await checkLocalPath(path);
  const info = await lstat(path);
  if (!info.isFile() || info.nlink !== 1 || info.size > 4096)
    throw new Error("Invalid managed service state file.");
  try {
    return serviceSchema.parse(JSON.parse(await readFile(path, "utf8")));
  } catch {
    throw new Error(
      "Invalid managed service state. Restore its backup; do not regenerate credentials for an existing volume.",
    );
  }
}
export async function createService(directory = serviceDirectory()) {
  await checkLocalPath(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const path = resolve(directory, "service.json");
  const state: ServiceState = {
    format: 1,
    instance: randomUUID(),
    password: randomBytes(32).toString("hex"),
    port: 55433,
  };
  try {
    await writeFile(path, `${JSON.stringify(state)}\n`, { flag: "wx", mode: 0o600 });
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
  }
  return readService(directory);
}
export const databaseUrl = (state: ServiceState) =>
  `postgresql://codememory:${state.password}@127.0.0.1:${state.port}/codememory`;
export const volumeName = "integra-code-memory-pg17";
export const composeProject = "integra-code-memory";
export function composeDefinition(state: ServiceState) {
  return {
    services: {
      postgres: {
        image: "pgvector/pgvector:pg17",
        restart: "unless-stopped",
        environment: {
          POSTGRES_USER: "codememory",
          POSTGRES_PASSWORD: state.password,
          POSTGRES_DB: "codememory",
        },
        ports: [`127.0.0.1:${state.port}:5432`],
        labels: { "io.integra.codememory.instance": state.instance },
        volumes: ["data:/var/lib/postgresql/data"],
        healthcheck: {
          test: ["CMD-SHELL", "pg_isready -U codememory -d codememory"],
          interval: "2s",
          timeout: "2s",
          retries: 60,
        },
      },
    },
    volumes: {
      data: { name: volumeName, labels: { "io.integra.codememory.instance": state.instance } },
    },
  };
}

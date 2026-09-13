import { createHash, randomUUID } from "node:crypto";
import { lstat, readFile, realpath, stat } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import { CodeMemoryError, type ProjectContext } from "@codememory/core";
import { z } from "zod";
import { version } from "../package.json";

const processStartedAt = new Date().toISOString();
export const runtimeInfo = () => ({ version, pid: process.pid, startedAt: processStartedAt });
export const hash = (value: string | Uint8Array) =>
  createHash("sha256").update(value).digest("hex");
export const id = (...parts: string[]) => hash(JSON.stringify(parts));
export const configSchema = z
  .object({
    maxFileSizeBytes: z
      .number()
      .int()
      .min(1024)
      .max(16 * 1024 * 1024)
      .default(2097152),
    parserTimeoutMs: z.number().int().min(1000).max(600000).default(120000),
    parserOutputLimitMiB: z.number().int().min(1).max(8192).default(1024),
    include: z.array(z.string().max(500)).max(100).default([]),
    exclude: z.array(z.string().max(500)).max(100).default([]),
    excludeGenerated: z.boolean().default(false),
    debounceMs: z.number().int().min(50).max(10000).default(300),
    reconcileMs: z.number().int().min(1000).max(3600000).default(30000),
  })
  .strict();
export function contains(root: string, path: string): boolean {
  const rel = relative(root, path);
  return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${sep}`));
}
export const slash = (path: string) => path.split(sep).join("/");
export function forbidden(path: string): boolean {
  return slash(path)
    .split("/")
    .some(
      (p) =>
        /^\.(git|codememory|next|nuxt|tmp|cache|workflow-tmp)$/.test(p) ||
        ["node_modules", "dist", "build", "coverage", "out", "vendor"].includes(p) ||
        /^\.env(?:\.|$)/i.test(p) ||
        /\.(pem|key|p12|pfx)$/i.test(p) ||
        /^(credentials|secrets)(\.|$)/i.test(p),
    );
}
export async function safePath(context: ProjectContext, path: string): Promise<string> {
  const candidate = resolve(context.canonicalRoot, path);
  if (
    !contains(context.canonicalRoot, candidate) ||
    forbidden(relative(context.canonicalRoot, candidate))
  )
    throw new CodeMemoryError("PATH_OUT_OF_SCOPE", "Path is outside the permitted source scope");
  const actual = await realpath(candidate).catch(() => {
    throw new CodeMemoryError("NOT_FOUND", "Source path not found");
  });
  if (
    !contains(context.canonicalRoot, actual) ||
    forbidden(relative(context.canonicalRoot, actual))
  )
    throw new CodeMemoryError("PATH_OUT_OF_SCOPE", "Path is outside the permitted source scope");
  let dir = resolve(actual, "..");
  while (contains(context.canonicalRoot, dir) && dir !== context.canonicalRoot) {
    if (
      await lstat(resolve(dir, ".git")).then(
        () => true,
        () => false,
      )
    )
      throw new CodeMemoryError("PATH_OUT_OF_SCOPE", "Nested repositories are excluded");
    dir = resolve(dir, "..");
  }
  return actual;
}
export async function createProjectContext(root?: string): Promise<ProjectContext> {
  if (!root || !isAbsolute(root))
    throw new CodeMemoryError(
      "PROJECT_ROOT_REQUIRED",
      "An explicit absolute --project path is required",
    );
  const canonicalRoot = await realpath(root);
  if (!(await stat(canonicalRoot)).isDirectory())
    throw new CodeMemoryError("PROJECT_ROOT_REQUIRED", "Project root must be a directory");
  const stateDirectory = resolve(canonicalRoot, ".codememory");
  const stateInfo = await lstat(stateDirectory).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
  if (stateInfo?.isSymbolicLink())
    throw new CodeMemoryError("PATH_OUT_OF_SCOPE", "Project state directory cannot be a symlink");
  let raw: unknown = {};
  const configPath = resolve(canonicalRoot, ".codememory/config.json");
  try {
    const actual = await realpath(configPath);
    if (!contains(canonicalRoot, actual))
      throw new CodeMemoryError("PATH_OUT_OF_SCOPE", "Configuration escapes project");
    if ((await stat(actual)).size > 65536)
      throw new CodeMemoryError("CONFIGURATION_ERROR", "Config exceeds 64 KiB");
    raw = JSON.parse(await readFile(actual, "utf8"));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
  const parsed = configSchema.safeParse(raw);
  if (!parsed.success) throw new CodeMemoryError("CONFIGURATION_ERROR", parsed.error.message);
  const effectiveConfig = Object.freeze({
    ...parsed.data,
    include: Object.freeze(parsed.data.include),
    exclude: Object.freeze(parsed.data.exclude),
  });
  return Object.freeze({
    sessionId: randomUUID(),
    projectScopeId: id(canonicalRoot),
    canonicalRoot,
    effectiveConfig,
    indexVersion: "schema:1/parser:1",
  });
}
export function log(level: string, event: string, fields: Record<string, unknown> = {}) {
  process.stderr.write(
    `${JSON.stringify({ time: new Date().toISOString(), level, event, ...fields })}\n`,
  );
}
export function publicError(error: unknown): {
  code: string;
  message: string;
  diagnosticId: string;
} {
  const diagnosticId = randomUUID();
  const code = error instanceof CodeMemoryError ? error.code : "INTERNAL_ERROR";
  // Never persist arbitrary exception messages, connection URLs or source text.
  log("error", "operation_failed", { diagnosticId, code, ...runtimeInfo() });
  return {
    code,
    message:
      error instanceof CodeMemoryError
        ? error.message
        : "Operation failed; match diagnosticId in the CLI/client stderr log",
    diagnosticId,
  };
}
export const projectName = (context: ProjectContext) => basename(context.canonicalRoot);

export { type GitChange, GitCli } from "./git";
export { checkForUpdates, newerRelease } from "./updates";

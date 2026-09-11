import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rename, rm, stat } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { checkForUpdates, newerRelease } from "@codememory/shared";
import { version } from "../../package.json";
import { managementDirectory } from "./cli-state";
import { origin, verifiedRuntime } from "./processes";
import { checkLocalPath } from "./service-state";

const exec = promisify(execFile);
export async function updateRuntime(requested?: string) {
  const status = requested ? undefined : await checkForUpdates({ force: true, current: version });
  if (status?.state === "up-to-date")
    return {
      ...status,
      next: "The shared runtime is current. Reconnect clients if they still report an older version.",
    };
  const tag = requested
    ? requested.startsWith("v")
      ? requested
      : `v${requested}`
    : status?.latestVersion;
  if (!tag || !/^v\d+\.\d+\.\d+(?:-alpha\.\d+)?$/.test(tag))
    throw new Error(
      "No verified release available. Check connectivity or pass --version <release>",
    );
  if (newerRelease(version, tag))
    throw new Error(
      "Downgrades are not automatic; preserve the active runtime and review rollback manually",
    );
  const response = await fetch(
    `https://api.github.com/repos/iOwsla/integra-codebase-memory/releases/tags/${tag}`,
    { redirect: "error", signal: AbortSignal.timeout(10000) },
  );
  if (!response.ok) throw new Error("Requested release has not been published");
  const release = (await response.json()) as { draft?: boolean; tag_name?: string };
  if (release.draft || release.tag_name !== tag) throw new Error("Release metadata mismatch");
  const directory = resolve(managementDirectory(), "../releases");
  await checkLocalPath(directory);
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const root = resolve(directory, tag);
  await checkLocalPath(root);
  if (!(await stat(root).catch(() => null))) {
    const temporary = await mkdtemp(resolve(directory, ".update-"));
    try {
      console.error(`Downloading ${tag}…`);
      await exec(
        "git",
        [
          "clone",
          "--quiet",
          "--depth",
          "1",
          "--branch",
          tag,
          "--",
          origin,
          resolve(temporary, "runtime"),
        ],
        { timeout: 180000 },
      );
      await exec(process.execPath, ["install", "--frozen-lockfile", "--ignore-scripts"], {
        cwd: resolve(temporary, "runtime"),
        timeout: 180000,
        maxBuffer: 4 * 1024 * 1024,
      });
      await rename(resolve(temporary, "runtime"), root);
    } finally {
      await rm(temporary, { recursive: true, force: true });
    }
  }
  const runtime = await verifiedRuntime(root);
  if (runtime.version !== tag.slice(1)) throw new Error("Downloaded runtime version mismatch");
  const gitTag = await exec("git", ["-C", root, "describe", "--tags", "--exact-match", "HEAD"]);
  const dirty = await exec("git", [
    "-C",
    root,
    "status",
    "--porcelain",
    "--untracked-files=normal",
  ]);
  if (gitTag.stdout.trim() !== tag || dirty.stdout.trim())
    throw new Error("Existing release has changes or an unexpected tag; use a clean runtime");
  await readFile(resolve(root, "scripts/activate-runtime.ts"));
  const check = await exec(
    process.execPath,
    [resolve(root, "apps/cli/src/index.ts"), "--version"],
    { timeout: 15000 },
  );
  if (check.stdout.trim() !== runtime.version) throw new Error("New runtime smoke check failed");
  console.error(
    `Verified ${tag}; migrating registered connections and retiring old MCP processes…`,
  );
  const activated = await exec(process.execPath, [resolve(root, "scripts/activate-runtime.ts")], {
    env: process.env,
    timeout: 120000,
    maxBuffer: 4 * 1024 * 1024,
  });
  return JSON.parse(activated.stdout);
}

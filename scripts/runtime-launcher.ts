import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Matches the empty-lock grace period of the activation lock writer. */
const lockGraceMs = 10000;
/** Set for the launched entry; a retired entry that calls back into the launcher sees it. */
const parentVariable = "CODEMEMORY_LAUNCH_PARENT";

/** An update lock blocks launches only while its owner is alive (or is still being written). */
function updateLockMessage(path: string) {
  let content: string;
  try {
    content = readFileSync(path, "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw e;
  }
  let pid: unknown;
  try {
    pid = JSON.parse(content).pid;
  } catch {
    pid = undefined;
  }
  if (typeof pid !== "number" || !Number.isInteger(pid) || pid < 1) {
    if (Date.now() - statSync(path).mtimeMs > lockGraceMs) return null;
    return "CodeMemory update lock is being written. Reconnect in a few seconds.";
  }
  try {
    process.kill(pid, 0);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ESRCH") return null;
  }
  return `CodeMemory update (process ${pid}) is in progress. Reconnect after it completes.`;
}

/** Copied into private user storage; keep this launcher dependency-free. */
export async function launch(managed: boolean) {
  const directory = dirname(fileURLToPath(import.meta.url));
  try {
    // A retired entry launched by this launcher would otherwise start itself again without end.
    if (process.env[parentVariable] === String(process.ppid))
      throw new Error(
        "Active runtime entry forwards back to the launcher. Run the bootstrap installer to repair it.",
      );
    const locked = updateLockMessage(resolve(directory, "update.lock"));
    if (locked) throw new Error(locked);
    const active = JSON.parse(readFileSync(resolve(directory, "active.json"), "utf8"));
    if (
      active.format !== 1 ||
      typeof active.root !== "string" ||
      typeof active.version !== "string"
    )
      throw new Error("Invalid active runtime. Run the bootstrap installer to repair it.");
    const entry = resolve(
      active.root,
      managed ? "scripts/managed-mcp.ts" : "apps/cli/src/index.ts",
    );
    if (!existsSync(entry)) throw new Error("Active runtime is missing. Reinstall CodeMemory.");
    if (readFileSync(entry, "utf8").startsWith("// CodeMemory retired entry"))
      throw new Error(
        "Active runtime entry is retired. Run codememory update or the bootstrap installer to repair it.",
      );
    const child = Bun.spawn([process.execPath, entry, ...process.argv.slice(2)], {
      env: { ...process.env, [parentVariable]: String(process.pid) },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    });
    const forward = (signal: "SIGINT" | "SIGTERM") => child.kill(signal);
    process.on("SIGINT", forward.bind(null, "SIGINT"));
    process.on("SIGTERM", forward.bind(null, "SIGTERM"));
    process.exitCode = await child.exited;
  } catch (error) {
    console.error(error instanceof Error ? error.message : "CodeMemory launcher failed");
    process.exitCode = 1;
  }
}

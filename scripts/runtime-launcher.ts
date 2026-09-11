import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** Copied into private user storage; keep this launcher dependency-free. */
export async function launch(managed: boolean) {
  const directory = dirname(fileURLToPath(import.meta.url));
  try {
    if (existsSync(resolve(directory, "update.lock")))
      throw new Error("CodeMemory update is in progress. Reconnect after it completes.");
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
    const child = Bun.spawn([process.execPath, entry, ...process.argv.slice(2)], {
      env: process.env,
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

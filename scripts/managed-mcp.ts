import { fileURLToPath } from "node:url";
import { databaseUrl, readService } from "./setup/service-state";

try {
  const state = await readService(process.env.CODEMEMORY_SERVICE_DIR);
  const child = Bun.spawn(
    [
      process.execPath,
      fileURLToPath(new URL("../apps/cli/src/index.ts", import.meta.url)),
      ...process.argv.slice(2),
    ],
    {
      env: { ...process.env, DATABASE_URL: databaseUrl(state) },
      stdin: "inherit",
      stdout: "inherit",
      stderr: "inherit",
    },
  );
  for (const signal of ["SIGINT", "SIGTERM"] as const) process.on(signal, () => child.kill(signal));
  process.exitCode = await child.exited;
} catch {
  console.error(
    "Managed CodeMemory database configuration is unavailable. Rerun the managed installer and start Docker Desktop/Engine.",
  );
  process.exitCode = 1;
}

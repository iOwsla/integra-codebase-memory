import { activateInstalledRuntime } from "./setup/activation";

// Without handlers Bun exits immediately and skips the rollback and lock release.
const controller = new AbortController();
const interrupt = (signal: NodeJS.Signals) => {
  if (!controller.signal.aborted)
    console.error(`Received ${signal}; rolling back after the current step…`);
  controller.abort();
};
const signals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;
for (const signal of signals) process.on(signal, interrupt);
try {
  const result = await activateInstalledRuntime(undefined, { signal: controller.signal });
  console.log(JSON.stringify(result, null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Activation failed");
  process.exitCode = controller.signal.aborted ? 130 : 1;
} finally {
  for (const signal of signals) process.off(signal, interrupt);
}

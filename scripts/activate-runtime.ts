import { activateInstalledRuntime } from "./setup/activation";

try {
  console.log(JSON.stringify(await activateInstalledRuntime(), null, 2));
} catch (error) {
  console.error(error instanceof Error ? error.message : "Activation failed");
  process.exitCode = 1;
}

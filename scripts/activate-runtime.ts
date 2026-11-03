import { activateInstalledRuntime } from "./setup/activation";
import { withInterruptSignal } from "./setup/interrupt";

const outcome = await withInterruptSignal((signal) =>
  activateInstalledRuntime(undefined, { signal }),
);
if (outcome.ok) console.log(JSON.stringify(outcome.value, null, 2));
else {
  console.error(outcome.error instanceof Error ? outcome.error.message : "Activation failed");
  process.exitCode = outcome.aborted ? 130 : 1;
}

const interruptSignals = ["SIGINT", "SIGTERM", "SIGHUP"] as const;

export type InterruptOutcome<T> =
  | { ok: true; value: T; aborted: boolean }
  | { ok: false; error: unknown; aborted: boolean };

/**
 * Runs `fn` with a signal that SIGINT, SIGTERM and SIGHUP abort instead of ending the process.
 * Without handlers Bun exits immediately and skips the rollback and lock release.
 */
export async function withInterruptSignal<T>(
  fn: (signal: AbortSignal) => Promise<T>,
): Promise<InterruptOutcome<T>> {
  const controller = new AbortController();
  const interrupt = (signal: NodeJS.Signals) => {
    if (!controller.signal.aborted)
      console.error(`Received ${signal}; rolling back after the current step…`);
    controller.abort();
  };
  for (const signal of interruptSignals) process.on(signal, interrupt);
  try {
    return { ok: true, value: await fn(controller.signal), aborted: controller.signal.aborted };
  } catch (error) {
    return { ok: false, error, aborted: controller.signal.aborted };
  } finally {
    for (const signal of interruptSignals) process.off(signal, interrupt);
  }
}

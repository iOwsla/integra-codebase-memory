import { EventEmitter } from "node:events";
import { CodeMemoryError, type ProjectContext, type ProjectStore } from "@codememory/core";
import { type IndexService, ProjectSession } from "@codememory/indexer";
import { configSchema } from "@codememory/shared";
import { afterEach, expect, it, vi } from "vitest";

const watchers = vi.hoisted(() => ({
  chokidar: [] as (EventEmitter & { close: () => Promise<void> })[],
  native: [] as { emitter: EventEmitter & { close: () => void }; listener: () => void }[],
}));
vi.mock("chokidar", () => ({
  default: {
    watch: () => {
      const watcher = Object.assign(new EventEmitter(), { close: async () => {} });
      watchers.chokidar.push(watcher);
      return watcher;
    },
  },
}));
vi.mock("node:fs", async (importOriginal) => ({
  ...(await importOriginal<typeof import("node:fs")>()),
  watch: (_root: string, _options: unknown, listener: () => void) => {
    const emitter = Object.assign(new EventEmitter(), { close: () => {} });
    watchers.native.push({ emitter, listener });
    return emitter;
  },
}));

const platform = process.platform;
afterEach(() => {
  Object.defineProperty(process, "platform", { value: platform });
  watchers.chokidar.length = 0;
  watchers.native.length = 0;
  vi.useRealTimers();
});
const context = {
  sessionId: "test",
  indexVersion: "0",
  canonicalRoot: "/selected",
  projectScopeId: "scope",
  effectiveConfig: configSchema.parse({}),
} as ProjectContext;
/** No database: status and registration are stubs, indexing always succeeds. */
function session(watch = true, index: () => Promise<unknown> = async () => ({ version: 1 })) {
  const store = {
    register: vi.fn(async () => {}),
    status: vi.fn(async () => ({ version: 1 })),
    recordFailure: vi.fn(async () => {}),
  } as unknown as ProjectStore;
  const indexer = { index: vi.fn(index) } as unknown as IndexService;
  return { session: new ProjectSession(context, store, indexer, !watch, watch), indexer };
}
const errno = (code: string) => Object.assign(new Error(code), { code });

it("keeps a chokidar watch failure visible after events from still-watched paths", async () => {
  Object.defineProperty(process, "platform", { value: "linux" });
  const { session: s } = session();
  try {
    await s.start();
    const watcher = watchers.chokidar[0];
    expect(watcher).toBeDefined();
    expect(await s.status()).toMatchObject({ watcher: true });
    watcher?.emit("error", errno("ENOSPC"));
    watcher?.emit("all", "change", "/selected/other.ts");
    const status = await s.status();
    expect(status.watcher).toBe(false);
    expect(status.watchError).toMatchObject({ code: "ENOSPC" });
  } finally {
    await s.close();
  }
});

it("clears a macOS native watch failure once the watcher is re-armed", async () => {
  vi.useFakeTimers();
  Object.defineProperty(process, "platform", { value: "darwin" });
  const { session: s } = session();
  try {
    await s.start();
    watchers.native[0]?.emitter.emit("error", errno("EMFILE"));
    expect(await s.status()).toMatchObject({ watcher: false, watchError: { code: "EMFILE" } });
    await vi.advanceTimersByTimeAsync(1000);
    expect(watchers.native).toHaveLength(2);
    const status = await s.status();
    expect(status.watcher).toBe(true);
    expect(status.watchError).toBeUndefined();
  } finally {
    await s.close();
  }
});

it.each([
  ["SCHEMA_OUTDATED", () => new CodeMemoryError("SCHEMA_OUTDATED", "Run setup")],
  ["a refused connection", () => errno("ECONNREFUSED")],
])("retries %s every reconcile interval without exponential backoff", async (_name, failure) => {
  vi.useFakeTimers();
  const reconcileMs = context.effectiveConfig.reconcileMs;
  const { session: s, indexer } = session(false, async () => {
    throw failure();
  });
  try {
    await s.start();
    await vi.advanceTimersByTimeAsync(0);
    for (let attempt = 1; attempt <= 4; attempt++) {
      expect(indexer.index).toHaveBeenCalledTimes(attempt);
      const status = await s.status();
      expect(status.retryAfterMs).toBeGreaterThan(0);
      expect(status.retryAfterMs).toBeLessThanOrEqual(reconcileMs);
      await vi.advanceTimersByTimeAsync(reconcileMs);
    }
  } finally {
    await s.close();
  }
});

it("still backs off an ordinary index failure exponentially", async () => {
  vi.useFakeTimers();
  const reconcileMs = context.effectiveConfig.reconcileMs;
  const { session: s, indexer } = session(false, async () => {
    throw new Error("analysis failed");
  });
  try {
    await s.start();
    await vi.advanceTimersByTimeAsync(0);
    expect(indexer.index).toHaveBeenCalledTimes(1);
    // No watcher and no change: nothing retries an input that fails the same way.
    await vi.advanceTimersByTimeAsync(reconcileMs);
    expect(indexer.index).toHaveBeenCalledTimes(1);
    expect((await s.status()).error).toBe("INDEX_ERROR");
  } finally {
    await s.close();
  }
});

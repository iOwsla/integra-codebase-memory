import { mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CodeMemoryError,
  type FileScanner,
  type IndexedFile,
  type IndexResult,
  type LanguagePlugin,
  type ProjectContext,
  type ProjectStore,
  type Snapshot,
} from "@codememory/core";
import { IndexService, ProjectSession } from "@codememory/indexer";
import { configSchema } from "@codememory/shared";
import { afterEach, expect, it, vi } from "vitest";
import { runBackgroundWork } from "../../packages/mcp-server/src/index";

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

const context = (root = "/selected", config: Record<string, unknown> = {}) =>
  ({
    sessionId: "test",
    indexVersion: "0",
    canonicalRoot: root,
    projectScopeId: "scope",
    effectiveConfig: configSchema.parse(config),
  }) as ProjectContext;

/** In-memory store with an exclusive lock, enough for IndexService and ProjectSession. */
function memoryStore() {
  let held = false;
  let state = { version: 0, fingerprint: "", indexedAt: null as string | null, files: [] };
  const store = {
    register: vi.fn(async () => {}),
    status: vi.fn(async () => ({ version: state.version })),
    recordFailure: vi.fn(async () => {}),
    recordIndexProgress: vi.fn(async () => {}),
    indexState: vi.fn(async () => state),
    publish: vi.fn(async (_c: ProjectContext, snapshot: Snapshot) => {
      state = {
        version: snapshot.version,
        fingerprint: snapshot.fingerprint,
        indexedAt: snapshot.indexedAt,
        files: snapshot.files as never,
      };
    }),
    async locked<T>(_c: ProjectContext, action: (s: ProjectStore) => Promise<T>) {
      if (held) throw new CodeMemoryError("INDEX_BUSY", "busy");
      held = true;
      try {
        return await action(store as unknown as ProjectStore);
      } finally {
        held = false;
      }
    },
  };
  return store;
}
const file = (path: string, content: string): IndexedFile => ({
  id: path,
  path,
  language: "typescript",
  hash: content,
  size: content.length,
  modifiedAt: "",
  generated: false,
  status: "INDEXED",
  content,
  parserVersion: "",
});
const scanner = (configs: () => Map<string, string>): FileScanner => ({
  scan: async () => ({
    files: [file("a.ts", "export const a=1")],
    configs: configs(),
    excluded: 0,
  }),
});
const plugin = (analyze: LanguagePlugin["analyze"]): LanguagePlugin => ({
  id: "fake",
  version: "1",
  extensions: [".ts"],
  analyze,
});
const emptyAnalysis = { symbols: [], edges: [], unresolved: [], diagnostics: [] };

it("cancels an in-flight analysis on close and releases the project lock", async () => {
  const store = memoryStore();
  let started!: () => void;
  const analyzing = new Promise<void>((resolve) => {
    started = resolve;
  });
  const analyze = vi.fn(
    (_c: ProjectContext, _f: IndexedFile[], _m: Map<string, string>, signal?: AbortSignal) =>
      new Promise<never>((_resolve, reject) => {
        started();
        signal?.addEventListener("abort", () =>
          reject(new CodeMemoryError("INDEX_CANCELLED", "cancelled")),
        );
      }),
  );
  const c = context();
  const session = new ProjectSession(
    c,
    store as unknown as ProjectStore,
    new IndexService(
      c,
      store as unknown as ProjectStore,
      scanner(() => new Map()),
      plugin(analyze),
    ),
    true,
    false,
  );
  await session.start();
  await analyzing;
  const begin = Date.now();
  await session.close();
  expect(Date.now() - begin).toBeLessThan(1000);
  expect(analyze.mock.calls[0]?.[3]?.aborted).toBe(true);
  // Cancellation records FAILED progress but is not reported as an index failure.
  expect(store.recordIndexProgress).toHaveBeenLastCalledWith(
    c,
    expect.objectContaining({ state: "FAILED", error: "INDEX_CANCELLED" }),
  );
  expect(store.recordFailure).not.toHaveBeenCalled();
  expect(store.publish).not.toHaveBeenCalled();
  await expect(store.locked(c, async () => "free")).resolves.toBe("free");
});

it("never publishes after cancellation when a plugin ignores the signal", async () => {
  const store = memoryStore();
  const controller = new AbortController();
  const c = context();
  const index = new IndexService(
    c,
    store as unknown as ProjectStore,
    scanner(() => new Map()),
    plugin(async () => {
      controller.abort();
      return emptyAnalysis;
    }),
  );
  await expect(index.index(false, controller.signal)).rejects.toMatchObject({
    code: "INDEX_CANCELLED",
  });
  expect(store.publish).not.toHaveBeenCalled();
});

it("backs off repeated identical failures and retries at once after a real change", async () => {
  vi.useFakeTimers();
  const root = await realpath(await mkdtemp(join(tmpdir(), "codememory-backoff-")));
  const store = memoryStore();
  const index = vi.fn(async () => {
    throw new CodeMemoryError("PARSER_ERROR", "Parser worker timed out");
  });
  const session = new ProjectSession(
    context(root, { reconcileMs: 1000 }),
    store as unknown as ProjectStore,
    { index } as unknown as IndexService,
    true,
    true,
  );
  try {
    await session.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(index).toHaveBeenCalledTimes(1);
    // Reconcile ticks every 1 s, but retries wait 1 s, 2 s, then 4 s after each failure.
    await vi.advanceTimersByTimeAsync(1340);
    expect(index).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1900);
    expect(index).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(100);
    expect(index).toHaveBeenCalledTimes(3);
    const status = await session.status();
    expect(status).toMatchObject({ state: "ERROR", error: "PARSER_ERROR", pendingChanges: 0 });
    expect(status.retryAfterMs).toBeGreaterThan(3000);
    await vi.advanceTimersByTimeAsync(3600);
    expect(index).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(400);
    expect(index).toHaveBeenCalledTimes(4);
    expect(store.recordFailure).toHaveBeenCalledTimes(4);
    // A real path event clears the backoff and retries after the debounce.
    emitChange(session, join(root, "a.ts"));
    await vi.advanceTimersByTimeAsync(310);
    expect(index).toHaveBeenCalledTimes(5);
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("keeps a watcher failure visible after a later successful index", async () => {
  vi.useFakeTimers();
  const root = await realpath(await mkdtemp(join(tmpdir(), "codememory-watch-")));
  const store = memoryStore();
  const index = vi.fn(async (): Promise<IndexResult> => ({ version: 1 }) as IndexResult);
  store.status.mockResolvedValue({ version: 1 });
  const session = new ProjectSession(
    context(root),
    store as unknown as ProjectStore,
    { index } as unknown as IndexService,
    true,
    true,
  );
  try {
    await session.start();
    await vi.advanceTimersByTimeAsync(10);
    expect(index).toHaveBeenCalledTimes(1);
    expect(await session.status()).toMatchObject({ watcher: true, watchError: undefined });
    watcherOf(session).emit("error", Object.assign(new Error("dropped"), { code: "EMFILE" }));
    // The error schedules an immediate reconcile, which succeeds.
    await vi.advanceTimersByTimeAsync(10);
    expect(index).toHaveBeenCalledTimes(2);
    expect(await session.status()).toMatchObject({
      state: "READY",
      error: undefined,
      watcher: false,
      watchError: { code: "EMFILE" },
    });
    if (process.platform === "darwin") {
      // The native watcher is re-armed with backoff, followed by a catch-up reconcile.
      await vi.advanceTimersByTimeAsync(1010);
      expect(await session.status()).toMatchObject({ watcher: true, watchError: undefined });
      expect(index).toHaveBeenCalledTimes(3);
      emitChange(session, join(root, "b.ts"));
      expect(session.liveState().pendingChanges).toBe(1);
    }
  } finally {
    await session.close();
    await rm(root, { recursive: true, force: true });
  }
});

it("ignores edits to ignore files in the fingerprint", async () => {
  const store = memoryStore();
  let gitignore = "dist\n";
  const c = context();
  const index = new IndexService(
    c,
    store as unknown as ProjectStore,
    scanner(
      () =>
        new Map([
          [".gitignore", gitignore],
          ["src/.codememoryignore", gitignore],
          ["package.json", "{}"],
        ]),
    ),
    plugin(async () => emptyAnalysis),
  );
  expect((await index.index()).reason).toBe("INITIAL");
  gitignore += "# comment\n";
  expect((await index.index()).reason).toBe("UNCHANGED");
  expect(store.publish).toHaveBeenCalledTimes(1);
});

it("keeps package.json in the fingerprint", async () => {
  const store = memoryStore();
  let manifest = "{}";
  const c = context();
  const index = new IndexService(
    c,
    store as unknown as ProjectStore,
    scanner(() => new Map([["package.json", manifest]])),
    plugin(async () => emptyAnalysis),
  );
  await index.index();
  manifest = '{"type":"module"}';
  expect((await index.index()).reason).toBe("PARSER_CONFIG_SCHEMA_CHANGED");
});

it("continues background work for later projects when one project's memory worker fails", async () => {
  const service = (projectScopeId: string, fail = false) => ({
    context: { projectScopeId } as ProjectContext,
    memoryWorkflow: {
      workOnce: vi.fn(async () => {
        if (fail) throw new Error("connection refused");
        return false;
      }),
    },
    history: { workOnce: vi.fn(async () => false) },
  });
  const first = service("first", true);
  const second = service("second");
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  await runBackgroundWork(
    [first, second] as unknown as Parameters<typeof runBackgroundWork>[0],
    new AbortController().signal,
  );
  expect(first.history.workOnce).toHaveBeenCalledTimes(1);
  expect(second.memoryWorkflow.workOnce).toHaveBeenCalledTimes(1);
  expect(second.history.workOnce).toHaveBeenCalledTimes(1);
  const logged = stderr.mock.calls.map(([line]) => String(line)).join("");
  expect(logged).toContain("memory_worker_failed");
  expect(logged).toContain('"projectScopeId":"first"');
});

type Emitter = { emit(event: string, ...args: unknown[]): boolean };
function watcherOf(session: ProjectSession) {
  return (session as unknown as { watcher: Emitter }).watcher;
}
/** Deliver a change the way the platform watcher would. */
function emitChange(session: ProjectSession, path: string) {
  if (process.platform === "darwin")
    watcherOf(session).emit("change", "change", path.split("/").pop());
  else watcherOf(session).emit("all", "change", path);
}

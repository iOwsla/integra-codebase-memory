import type { ProjectStore } from "@codememory/core";
import type { ProjectSession } from "@codememory/indexer";
import { createProjectContext } from "@codememory/shared";
import { afterEach, expect, it, vi } from "vitest";

vi.mock("@modelcontextprotocol/server/stdio", () => ({
  serveStdio: () => ({ close: async () => {} }),
}));

const { closeWorkspace, runBackgroundWork, runMcpWorkspace } = await import(
  "../../packages/mcp-server/src/index"
);

afterEach(() => {
  process.exitCode = undefined;
  vi.restoreAllMocks();
});

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A session stuck in an uncancellable publish, and a store whose close() waits for it like pool.end(). */
function publishing() {
  const publish = deferred();
  const session = { close: vi.fn(() => publish.promise) };
  const store = { close: vi.fn(() => publish.promise) };
  return { publish, session, store };
}

it("forces exit within the deadline while a publish holds the store open", async () => {
  const stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const { publish, session, store } = publishing();
  const context = await createProjectContext(process.cwd());
  const fakeSession = Object.assign(session, {
    context,
    start: async () => {},
  }) as unknown as ProjectSession;
  const onForcedExit = vi.fn();
  const started = Date.now();
  const workspace = await runMcpWorkspace(
    [{ session: fakeSession, store: store as unknown as ProjectStore }],
    undefined,
    { shutdownDeadlineMs: 50, onForcedExit },
  );
  await workspace.close();
  const elapsed = Date.now() - started;
  expect(onForcedExit).toHaveBeenCalledWith(1);
  expect(elapsed).toBeLessThan(1000);
  expect(session.close).toHaveBeenCalledTimes(1);
  expect(store.close).toHaveBeenCalledTimes(1);
  expect(stderr.mock.calls.some(([line]) => String(line).includes("session_close_timeout"))).toBe(
    true,
  );
  publish.resolve();
});

it("closes stores and does not force exit when sessions close in time", async () => {
  const session = { close: vi.fn(async () => {}) };
  const store = { close: vi.fn(async () => {}) };
  const transport = vi.fn(async () => {});
  await expect(closeWorkspace([{ session, store }], [], transport, 1000)).resolves.toBe(true);
  expect(transport).toHaveBeenCalledTimes(1);
  expect(store.close).toHaveBeenCalledTimes(1);
});

it("aborts the index before pending background work settles", async () => {
  vi.spyOn(process.stderr, "write").mockImplementation(() => true);
  const abort = new AbortController();
  const work = deferred();
  let workSettled = false;
  const service = {
    context: { projectScopeId: "p" },
    memoryWorkflow: {
      workOnce: () =>
        work.promise.then(() => {
          workSettled = true;
        }),
    },
    history: { workOnce: async () => {} },
  };
  const workerPending = runBackgroundWork(
    [service] as unknown as Parameters<typeof runBackgroundWork>[0],
    abort.signal,
  );
  abort.abort();
  let closedBeforeWork: boolean | undefined;
  const session = {
    close: vi.fn(async () => {
      closedBeforeWork = !workSettled;
    }),
  };
  const store = { close: vi.fn(async () => {}) };
  const closing = closeWorkspace([{ session, store }], [workerPending], async () => {}, 1000);
  await Promise.resolve();
  expect(session.close).toHaveBeenCalledTimes(1);
  work.resolve();
  await expect(closing).resolves.toBe(true);
  expect(closedBeforeWork).toBe(true);
  expect(store.close).toHaveBeenCalledTimes(1);
});

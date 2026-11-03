import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import type { ProjectContext } from "@codememory/core";
import { ProcessTypeScriptPlugin } from "../../packages/plugin-typescript/src/process-plugin";

function worker(
  timeoutMs?: number,
  parserOutputLimitMiB?: number,
  profile?: ConstructorParameters<typeof ProcessTypeScriptPlugin>[1],
) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  spawn.mockReturnValue(child);
  const result = new ProcessTypeScriptPlugin(undefined, profile).analyze(
    { effectiveConfig: { parserTimeoutMs: timeoutMs, parserOutputLimitMiB } } as ProjectContext,
    [],
    new Map(),
  );
  return { child, result };
}
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});
it("reports timeout and forcibly stops the isolated worker", async () => {
  vi.useFakeTimers();
  const { child, result } = worker();
  const assertion = expect(result).rejects.toThrow("timed out after 120000 ms");
  await vi.advanceTimersByTimeAsync(120000);
  await assertion;
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  expect(vi.getTimerCount()).toBe(0);
});
it.each([
  ["error", "could not start"],
  ["input", "input stream failed"],
  ["exit", "code 2"],
  ["json", "invalid JSON"],
])("distinguishes worker %s failures without exposing source content", async (kind, message) => {
  const { child, result } = worker();
  const assertion = expect(result).rejects.toThrow(message);
  if (kind === "error") child.emit("error", new Error("private content"));
  if (kind === "input") child.stdin.emit("error", new Error("private content"));
  if (kind === "exit") child.emit("close", 2, null);
  if (kind === "json") {
    child.stdout.emit("data", Buffer.from("private invalid JSON"));
    child.emit("close", 0, null);
  }
  await assertion;
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});
it("accepts successful output without terminating the worker", async () => {
  const { child, result } = worker();
  const analysis = { symbols: [], edges: [], unresolved: [], diagnostics: [] };
  child.stdout.emit("data", Buffer.from('{"type":"complete"}\n'));
  child.emit("close", 0, null);
  expect(await result).toEqual(analysis);
  expect(child.kill).not.toHaveBeenCalled();
});
it("honors a validated project-specific deadline", async () => {
  vi.useFakeTimers();
  const { child, result } = worker(1000);
  const assertion = expect(result).rejects.toThrow("timed out after 1000 ms");
  await vi.advanceTimersByTimeAsync(999);
  expect(child.kill).not.toHaveBeenCalled();
  await vi.advanceTimersByTimeAsync(1);
  await assertion;
});
it.each([0, 999, 600001, Infinity, 1000.5])(
  "rejects invalid parser deadlines (%s) before spawning",
  async (timeoutMs) => {
    const { result } = worker(timeoutMs);
    await expect(result).rejects.toThrow("between 1000 and 600000 ms");
    expect(spawn).not.toHaveBeenCalled();
  },
);

it("decodes split UTF-8 records and requires a completion marker", async () => {
  const { child, result } = worker();
  const bytes = Buffer.from(
    `${JSON.stringify({ type: "diagnostics", value: { file: "ö.ts", message: "ok" } })}\n{"type":"complete"}\n`,
  );
  for (const byte of bytes) child.stdout.emit("data", Buffer.from([byte]));
  child.emit("close", 0, null);
  expect((await result).diagnostics).toEqual([{ file: "ö.ts", message: "ok" }]);
});
it("honors a lower configured output limit", async () => {
  const { child, result } = worker(undefined, 1);
  const assertion = expect(result).rejects.toThrow("1 MiB output limit");
  child.stdout.emit("data", Buffer.alloc(1024 * 1024 + 1));
  await assertion;
});
it.each([0, -1, 8193, Infinity, 1.5])("rejects invalid output limits (%s)", async (limit) => {
  const { result } = worker(undefined, limit);
  await expect(result).rejects.toThrow("between 1 and 8192 MiB");
  expect(spawn).not.toHaveBeenCalled();
});
it("rejects a successful exit with truncated records", async () => {
  const { child, result } = worker();
  const assertion = expect(result).rejects.toThrow("invalid JSON");
  child.stdout.emit("data", Buffer.from('{"type":"diagnostics","value":{}}\n'));
  child.emit("close", 0, null);
  await assertion;
});
it("accepts more than 256 MiB in bounded records without accumulating serialized output", async () => {
  const { child, result } = worker();
  const record = Buffer.from(
    `{"type":"diagnostics","value":{"file":"large.ts","message":"ok"}}${" ".repeat(1024 * 1024)}\n`,
  );
  for (let i = 0; i < 257; i++) child.stdout.emit("data", record);
  child.stdout.emit("data", Buffer.from('{"type":"complete"}\n'));
  child.emit("close", 0, null);
  expect((await result).diagnostics).toHaveLength(257);
  expect(child.kill).not.toHaveBeenCalled();
});

it("delivers parser progress separately from the resulting graph", async () => {
  const profile = vi.fn();
  const { child, result } = worker(undefined, undefined, profile);
  child.stdout.emit(
    "data",
    Buffer.from(
      '{"type":"progress","value":{"phase":"SEMANTIC_FILE","durationMs":2,"file":"a.ts","completedFiles":4}}\n{"type":"complete"}\n',
    ),
  );
  child.emit("close", 0, null);
  expect(profile).toHaveBeenCalledWith(
    expect.objectContaining({ file: "a.ts", completedFiles: 4 }),
  );
  expect(await result).toEqual({ symbols: [], edges: [], unresolved: [], diagnostics: [] });
});

function cancellable(signal: AbortSignal, canonicalRoot?: string) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  spawn.mockReturnValue(child);
  const result = new ProcessTypeScriptPlugin().analyze(
    { canonicalRoot, effectiveConfig: {} } as ProjectContext,
    [],
    new Map(),
    signal,
  );
  return { child, result };
}
it("kills the worker and rejects with INDEX_CANCELLED when the job is aborted", async () => {
  const controller = new AbortController();
  const { child, result } = cancellable(controller.signal);
  const assertion = expect(result).rejects.toMatchObject({ code: "INDEX_CANCELLED" });
  controller.abort();
  await assertion;
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});
it("does not spawn a worker for an already aborted job", async () => {
  const controller = new AbortController();
  controller.abort();
  await expect(cancellable(controller.signal).result).rejects.toMatchObject({
    code: "INDEX_CANCELLED",
  });
  expect(spawn).not.toHaveBeenCalled();
});
it("stops listening for cancellation once the worker completes", async () => {
  const controller = new AbortController();
  const { child, result } = cancellable(controller.signal);
  child.stdout.emit("data", Buffer.from('{"type":"complete"}\n'));
  child.emit("close", 0, null);
  await result;
  controller.abort();
  expect(child.kill).not.toHaveBeenCalled();
});
it("includes the sanitized stderr tail when the worker crashes", async () => {
  const { child, result } = cancellable(new AbortController().signal, "/projects/app");
  const failure = result.catch((error: Error & { code?: string }) => error);
  child.stderr.emit("data", Buffer.from("x".repeat(20000)));
  child.stderr.emit(
    "data",
    Buffer.from("TypeError: boom\u001b[31m\n    at check (/projects/app/src/a.ts:3:1)\n"),
  );
  child.emit("close", 1, null);
  const error = (await failure) as Error & { code?: string };
  expect(error.code).toBe("PARSER_ERROR");
  expect(error.message).toContain("code 1");
  expect(error.message).toContain("TypeError: boom");
  expect(error.message).toContain("at check (src/a.ts:3:1)");
  expect(error.message).not.toContain("/projects/app");
  expect(error.message).not.toContain("\u001b");
  expect(error.message.length).toBeLessThan(8 * 1024 + 200);
});
it("defaults the output limit to 4096 MiB", async () => {
  const { child, result } = cancellable(new AbortController().signal);
  const record = Buffer.from(
    `{"type":"diagnostics","value":{"file":"large.ts","message":"ok"}}${" ".repeat(1024 * 1024)}\n`,
  );
  for (let i = 0; i < 1025; i++) child.stdout.emit("data", record);
  child.stdout.emit("data", Buffer.from('{"type":"complete"}\n'));
  child.emit("close", 0, null);
  expect((await result).diagnostics).toHaveLength(1025);
  expect(child.kill).not.toHaveBeenCalled();
});

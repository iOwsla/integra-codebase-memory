import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import type { ProjectContext } from "@codememory/core";
import { ProcessTypeScriptPlugin } from "../../packages/plugin-typescript/src/process-plugin";

function worker(timeoutMs?: number, parserOutputLimitMiB?: number) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  spawn.mockReturnValue(child);
  const result = new ProcessTypeScriptPlugin().analyze(
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

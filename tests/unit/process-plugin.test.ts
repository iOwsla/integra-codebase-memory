import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { afterEach, expect, it, vi } from "vitest";

const { spawn } = vi.hoisted(() => ({ spawn: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));

import type { ProjectContext } from "@codememory/core";
import { ProcessTypeScriptPlugin } from "../../packages/plugin-typescript/src/process-plugin";

function worker(timeoutMs?: number) {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(),
  });
  spawn.mockReturnValue(child);
  const result = new ProcessTypeScriptPlugin().analyze(
    { effectiveConfig: { parserTimeoutMs: timeoutMs } } as ProjectContext,
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
  ["limit", "256 MiB output limit"],
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
  if (kind === "limit") {
    const chunk = Buffer.alloc(1024 * 1024);
    for (let i = 0; i < 257; i++) child.stdout.emit("data", chunk);
  }
  await assertion;
  expect(child.kill).toHaveBeenCalledWith("SIGKILL");
});
it("accepts successful output without terminating the worker", async () => {
  const { child, result } = worker();
  const analysis = { symbols: [], edges: [], unresolved: [], diagnostics: [] };
  child.stdout.emit("data", Buffer.from(JSON.stringify(analysis)));
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

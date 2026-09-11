import { afterEach, expect, it, vi } from "vitest";
import { CliProgress } from "../../scripts/setup/progress";

afterEach(() => vi.useRealTimers());
it("throttles file output, strips terminal controls and closes timers once", () => {
  vi.useFakeTimers();
  vi.setSystemTime(10000);
  const write = vi.fn((_text: string | Uint8Array) => true);
  const progress = new CliProgress("/project", true, { write, isTTY: true, columns: 140 });
  for (let i = 0; i < 1000; i++) progress.scan("hash", `/project/file-${i}.ts`);
  expect(write).toHaveBeenCalledTimes(1);
  vi.advanceTimersByTime(200);
  expect(write.mock.calls.at(-1)?.[0]).toContain("1000 files");
  vi.setSystemTime(11000);
  progress.scan("hash", "/project/evil\x1b]0;name\x07.ts");
  expect(write.mock.calls.at(-1)?.[0]).not.toContain("\x1b]0;");
  progress.close();
  progress.close();
  expect(vi.getTimerCount()).toBe(0);
  expect(write.mock.calls.at(-1)?.[0]).toBe("\n");
});
it("emits no output or timers when disabled", () => {
  vi.useFakeTimers();
  const write = vi.fn((_text: string | Uint8Array) => true);
  const p = new CliProgress("/project", false, { write, isTTY: false, columns: 80 });
  p.scan("hash", "/project/a.ts");
  p.close();
  expect(write).not.toHaveBeenCalled();
  expect(vi.getTimerCount()).toBe(0);
});
it("keeps non-TTY output plain and reports interrupted status honestly", () => {
  const write = vi.fn((_text: string | Uint8Array) => true);
  const p = new CliProgress("/project", true, { write, isTTY: false, columns: 80 }, false);
  p.status({
    files: 5,
    lastIndexJob: { state: "RUNNING", stage: "PUBLISHING", interrupted: true },
  });
  expect(write.mock.calls.at(-1)?.[0]).toContain("INTERRUPTED PUBLISHING");
  expect(write.mock.calls.at(-1)?.[0]).not.toContain("\x1b");
  p.close();
});

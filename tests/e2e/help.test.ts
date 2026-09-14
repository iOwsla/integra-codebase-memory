import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

const help = async (...args: string[]) =>
  (await promisify(execFile)("bun", [resolve("apps/cli/src/index.ts"), ...args])).stdout;
it("shows common commands by default and keeps advanced and legacy commands discoverable", async () => {
  const common = await help("--help");
  expect(common).toContain("projects");
  expect(common).toContain("--help-all");
  expect(common).not.toContain("debug [options]");
  const all = await help("--help-all");
  expect(all).toContain("debug [options]");
  expect(all).toContain("init [options]");
  expect(await help("debug", "--help")).toContain("unresolved");
  expect(await help("help", "history")).toContain("scan");
});
it("preserves full recovery controls and advanced provider options without executing actions", async () => {
  expect(await help("history", "--help")).not.toContain("restore [options]");
  expect(await help("history", "--help-all")).toContain("restore [options]");
  expect(await help("history", "restore", "--help")).toContain("--yes");
  expect(await help("providers", "add", "--help")).not.toContain("--input-rate");
  expect(await help("providers", "add", "--help-all")).toContain("--input-rate");
});

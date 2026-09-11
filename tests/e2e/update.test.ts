import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { expect, it } from "vitest";

it("migrates every registered project and stops only verified old MCP processes", async () => {
  const result = await promisify(execFile)("bun", [resolve("scripts/verify-upgrade.ts")], {
    timeout: 60000,
  });
  expect(JSON.parse(result.stdout)).toMatchObject({ passed: true });
}, 65000);

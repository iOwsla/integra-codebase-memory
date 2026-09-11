import { execFile, spawn } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it } from "vitest";

const exec = promisify(execFile);
it("streams index stages separately from JSON and watches status without triggering an index", async () => {
  const db = await testDatabase(),
    f = await fixture({ "main.ts": "export function answer(){return 42}" });
  const cli = resolve("apps/cli/src/index.ts");
  const env = {
    ...process.env,
    DATABASE_URL: db.url,
    XDG_DATA_HOME: resolve(f.root, "state"),
    LOCALAPPDATA: resolve(f.root, "state"),
    CODEMEMORY_UPDATE_CHECK: "0",
  };
  let child: ReturnType<typeof spawn> | undefined;
  try {
    const first = await exec("bun", [cli, "index", "--project", f.root], { env });
    expect(JSON.parse(first.stdout)).toMatchObject({ version: 1, changed: 1 });
    for (const stage of ["SCANNING", "ANALYZING", "PUBLISHING", "COMPLETE"])
      expect(first.stderr).toContain(stage);
    const quiet = await exec("bun", [cli, "index", "--project", f.root, "--no-progress"], { env });
    expect(JSON.parse(quiet.stdout).reason).toBe("UNCHANGED");
    expect(quiet.stderr).toBe("");
    child = spawn("bun", [cli, "status", "--project", f.root, "--watch", "--json"], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    const exited = new Promise<number | null>((ok, reject) => {
      child?.once("exit", ok);
      child?.once("error", reject);
    });
    const line = await new Promise<string>((ok, reject) => {
      let output = "";
      const timer = setTimeout(() => reject(new Error("Status watch did not respond")), 10000);
      child?.stdout?.on("data", (chunk) => {
        output += chunk.toString();
        if (output.includes("\n")) {
          clearTimeout(timer);
          ok(output.split("\n")[0] as string);
        }
      });
    });
    expect(JSON.parse(line)).toMatchObject({
      version: 1,
      lastIndexJob: { state: "SUCCEEDED", stage: "COMPLETE" },
    });
    child.kill("SIGINT");
    await exited;
  } finally {
    child?.kill("SIGKILL");
    await db.dispose();
    await f.dispose();
  }
});

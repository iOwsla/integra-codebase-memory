import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fixture } from "@codememory/test-utils";
import { expect, it } from "vitest";

const exec = promisify(execFile);
const script = resolve("bootstrap.sh");
it("bootstraps from stdin with explicit scope and previews without writes", async () => {
  const f = await fixture({});
  try {
    const args = [
      "--project",
      f.root,
      "--client",
      "both",
      "--install-dir",
      resolve(f.root, "runtime"),
    ];
    const result = await new Promise<string>((ok, reject) => {
      const child = execFile("sh", ["-s", "--", ...args], (error, stdout) =>
        error ? reject(error) : ok(stdout),
      );
      readFile(script).then((data) => child.stdin!.end(data), reject);
    });
    expect(result).toContain("Preview:");
    expect(await readdir(f.root)).toEqual([]);
    await expect(
      exec("sh", [script, "--project", "relative", "--client", "both"]),
    ).rejects.toBeDefined();
    await expect(
      exec("sh", [script, "--project", f.root, "--client", "global"]),
    ).rejects.toBeDefined();
    await expect(
      exec("sh", [script, ...args, "--install-dir", f.root, "--write"]),
    ).rejects.toMatchObject({ stderr: expect.stringContaining("already exists") });
  } finally {
    await f.dispose();
  }
});

it("downloads into persistent storage, passes only explicit scope and cleans failed downloads", async () => {
  const f = await fixture({
    "bin/git":
      '#!/bin/sh\n[ "$1" = clone ] || exit 9\nfor destination do :; done\nmkdir -p "$destination"\n[ "$FAIL_DOWNLOAD" != yes ] || exit 8\nprintf \'#!/bin/sh\\nprintf "arg: %%s\\\\n" "$@"\\n\' > "$destination/install.sh"\n',
    "bin/bun":
      '#!/bin/sh\n[ "$*" = "install --frozen-lockfile --ignore-scripts" ] || exit 7\nmkdir node_modules\n',
    "target/.keep": "",
  });
  const { chmod } = await import("node:fs/promises");
  try {
    for (const binary of ["git", "bun"]) await chmod(resolve(f.root, "bin", binary), 0o755);
    const env = { ...process.env, PATH: `${resolve(f.root, "bin")}:${process.env.PATH}` };
    const args = [
      script,
      "--project",
      resolve(f.root, "target"),
      "--client",
      "claude",
      "--install-dir",
      resolve(f.root, "runtime"),
      "--write",
    ];
    const output = await exec("sh", args, { env });
    expect(output.stdout).toContain(`arg: ${resolve(f.root, "target")}`);
    expect(output.stdout).toContain("arg: claude");
    expect(await readdir(resolve(f.root, "runtime"))).toContain("node_modules");
    await expect(
      exec("sh", [...args.slice(0, -3), "--install-dir", resolve(f.root, "failed"), "--write"], {
        env: { ...env, FAIL_DOWNLOAD: "yes" },
      }),
    ).rejects.toBeDefined();
    expect((await readdir(f.root)).some((name) => name.startsWith(".codememory-download"))).toBe(
      false,
    );
    expect(await readdir(f.root)).not.toContain("failed");
  } finally {
    await f.dispose();
  }
});

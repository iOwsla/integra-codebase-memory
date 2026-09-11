import { readFile, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture } from "@codememory/test-utils";
import { expect, it } from "vitest";
import { connectCodex } from "../../scripts/connect-codex";

it("previews and idempotently installs an explicitly scoped config without overwriting settings", async () => {
  const f = await fixture({});
  try {
    const preview = await connectCodex(f.root, "/runtime path/bun", '/server "path"/index.ts');
    expect(preview.written).toBe(false);
    await expect(readFile(preview.path)).rejects.toMatchObject({ code: "ENOENT" });
    expect(preview.config).toContain(JSON.stringify(f.root));
    expect(preview.config).toContain("--auto-index");
    const installed = await connectCodex(
      f.root,
      "/runtime path/bun",
      '/server "path"/index.ts',
      true,
    );
    expect(await readFile(installed.path, "utf8")).toBe(preview.config);
    await connectCodex(f.root, "/runtime path/bun", '/server "path"/index.ts', true);
    await writeFile(installed.path, "# existing user settings\n");
    await expect(connectCodex(f.root, "/bun", "/entry", true)).rejects.toThrow(
      "nothing was overwritten",
    );
    expect(await readFile(installed.path, "utf8")).toBe("# existing user settings\n");
  } finally {
    await f.dispose();
  }
});
it("refuses configuration paths redirected outside the project", async () => {
  const f = await fixture({}),
    outside = await fixture({ "config.toml": "keep" });
  try {
    await symlink(outside.root, resolve(f.root, ".codex"));
    await expect(connectCodex(f.root, "/bun", "/entry", true)).rejects.toThrow("regular directory");
    expect(await readFile(resolve(outside.root, "config.toml"), "utf8")).toBe("keep");
  } finally {
    await f.dispose();
    await outside.dispose();
  }
});

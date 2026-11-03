import { rmSync, symlinkSync, unlinkSync } from "node:fs";
import { chmod, mkdir, rm, symlink, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { RepositoryScanner } from "@codememory/indexer";
import { createProjectContext, safePath } from "@codememory/shared";
import { fixture } from "@codememory/test-utils";
import { expect, it } from "vitest";

const root = process.getuid?.() === 0;

it.skipIf(root)("fails with SCAN_UNREADABLE_DIRECTORY instead of a raw error", async () => {
  const f = await fixture({ "main.ts": "export const a=1", "sub/hidden.ts": "export const b=1" });
  try {
    await chmod(resolve(f.root, "sub"), 0o000);
    const c = await createProjectContext(f.root);
    const failure = await new RepositoryScanner().scan(c).catch((error: unknown) => error);
    expect(failure).toMatchObject({ code: "SCAN_UNREADABLE_DIRECTORY" });
    expect((failure as Error).message).toContain("sub");
  } finally {
    await chmod(resolve(f.root, "sub"), 0o755);
    await f.dispose();
  }
});

it("skips a directory removed between listing and recursion", async () => {
  const f = await fixture({ "main.ts": "export const a=1", "gone/inner.ts": "export const b=1" });
  try {
    const c = await createProjectContext(f.root);
    const gone = resolve(c.canonicalRoot, "gone");
    const scan = await new RepositoryScanner((event, path) => {
      if (event === "scan" && path === gone) rmSync(gone, { recursive: true });
    }).scan(c);
    expect(scan.files.map((file) => file.path)).toEqual(["main.ts"]);
  } finally {
    await f.dispose();
  }
});

it("reports a .gitignore symlinked outside the root and continues", async () => {
  const a = await fixture({ "main.ts": "export const a=1" }),
    b = await fixture({ "rules.txt": "main.ts\n" });
  try {
    await symlink(resolve(b.root, "rules.txt"), resolve(a.root, ".gitignore"));
    const c = await createProjectContext(a.root);
    const read: string[] = [];
    const scan = await new RepositoryScanner((_event, path) => read.push(path)).scan(c);
    expect(scan.exclusions.byReason.IGNORE_FILE_OUT_OF_SCOPE).toMatchObject({ files: 1 });
    expect(scan.files.map((file) => file.path)).toEqual(["main.ts"]);
    expect(read.every((path) => !path.startsWith(b.root))).toBe(true);
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

it("records a package.json deleted mid-scan and continues", async () => {
  const f = await fixture({ "package.json": '{"name":"x"}', "main.ts": "export const a=1" });
  try {
    const c = await createProjectContext(f.root);
    const pkg = resolve(c.canonicalRoot, "package.json");
    const scan = await new RepositoryScanner((event, path) => {
      if (event === "read" && path === pkg) unlinkSync(pkg);
    }).scan(c);
    expect(scan.configs.has("package.json")).toBe(false);
    expect(scan.exclusions.byReason.CONFIG_VANISHED).toMatchObject({ files: 1 });
    expect(scan.files.map((file) => file.path)).toEqual(["main.ts"]);
  } finally {
    await f.dispose();
  }
});

it("indexes a source file with a literal NUL and keeps real binaries skipped", async () => {
  const f = await fixture({ "a.ts": 'export const s = "x\0y";\n' });
  try {
    // Deterministic noise that is not valid UTF-8 (0xff never appears in UTF-8).
    const noise = Buffer.alloc(4096);
    let seed = 7;
    for (let i = 0; i < noise.length; i++) {
      seed = (seed * 1103515245 + 12345) & 0x7fffffff;
      noise[i] = seed & 0xff;
    }
    noise[10] = 0;
    noise[11] = 0xff;
    await writeFile(resolve(f.root, "b.ts"), noise);
    await writeFile(resolve(f.root, "c.ts"), Buffer.from([0xff, 0xfe, 0x61, 0x00]));
    const c = await createProjectContext(f.root);
    const scan = await new RepositoryScanner().scan(c);
    const byPath = new Map(scan.files.map((file) => [file.path, file]));
    const a = byPath.get("a.ts");
    expect(a?.status).toBe("INDEXED");
    expect(a?.content).toBe('export const s = "x y";\n');
    expect(a?.content.includes("\0")).toBe(false);
    expect(a?.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(byPath.get("b.ts")?.status).toBe("SKIPPED_BINARY");
    expect(byPath.get("c.ts")?.status).toBe("SKIPPED_BINARY");
  } finally {
    await f.dispose();
  }
});

it("still rejects a listed file replaced by an out-of-root symlink before it is read", async () => {
  const a = await fixture({ "a.ts": "export const a=1", "z.ts": "export const z=1" }),
    b = await fixture({ "secret.ts": "export const secret=1" });
  try {
    const c = await createProjectContext(a.root);
    const z = resolve(c.canonicalRoot, "z.ts");
    const read: string[] = [];
    // The directory listing already holds z.ts as a regular file when it is swapped.
    const scanner = new RepositoryScanner((event, path) => {
      read.push(path);
      if (event === "read" && path.endsWith("/a.ts")) {
        rmSync(z);
        symlinkSync(resolve(b.root, "secret.ts"), z);
      }
    });
    await expect(scanner.scan(c)).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
    expect(read.every((path) => !path.startsWith(b.root))).toBe(true);
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

it("keeps realpath scope checks when ancestors are vetted", async () => {
  const a = await fixture({ "main.ts": "export const a=1", "nested/.git": "", "nested/x.ts": "" }),
    b = await fixture({ "secret.ts": "export const secret=1" });
  try {
    await mkdir(resolve(a.root, "links"));
    await symlink(resolve(b.root, "secret.ts"), resolve(a.root, "links/out.ts"));
    const c = await createProjectContext(a.root);
    await expect(safePath(c, "links/out.ts", { ancestorsVetted: true })).rejects.toMatchObject({
      code: "PATH_OUT_OF_SCOPE",
    });
    await expect(safePath(c, ".env", { ancestorsVetted: true })).rejects.toMatchObject({
      code: "PATH_OUT_OF_SCOPE",
    });
    // The full check still rejects nested repositories for externally supplied paths.
    await expect(safePath(c, "nested/x.ts")).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
    await rm(resolve(a.root, "links"), { recursive: true });
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

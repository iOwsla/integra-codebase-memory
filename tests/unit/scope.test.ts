import { symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { RepositoryScanner } from "@codememory/indexer";
import { contains, createProjectContext, safePath } from "@codememory/shared";
import { fixture } from "@codememory/test-utils";
import { expect, it } from "vitest";

it("rejects missing and relative project roots", async () => {
  await expect(createProjectContext()).rejects.toMatchObject({ code: "PROJECT_ROOT_REQUIRED" });
  await expect(createProjectContext(".")).rejects.toMatchObject({ code: "PROJECT_ROOT_REQUIRED" });
  expect(contains("/a", "/ab")).toBe(false);
});
it("does not scan symlinks, ignored files, nested repositories, secrets or own state", async () => {
  const a = await fixture({
    "main.ts": "export const ok=1",
    ".gitignore": "ignored/\n",
    "ignored/no.ts": "secret",
    "node_modules/no.ts": "secret",
    ".env.ts": "secret",
    ".codememory/state.ts": "secret",
    "nested/.git": "gitdir: elsewhere",
    "nested/no.ts": "secret",
  });
  const b = await fixture({ "other.ts": "export const privateB=1" });
  try {
    await symlink(b.root, resolve(a.root, "outside"));
    const c = await createProjectContext(a.root);
    const calls: string[] = [];
    const scan = await new RepositoryScanner((_event, p) => calls.push(p)).scan(c);
    expect(scan.files.map((f) => f.path)).toEqual(["main.ts"]);
    expect(calls.every((p) => !p.startsWith(b.root))).toBe(true);
    await expect(safePath(c, "../escape")).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
    await expect(safePath(c, "outside/other.ts")).rejects.toMatchObject({
      code: "PATH_OUT_OF_SCOPE",
    });
    await expect(safePath(c, "nested/no.ts")).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
  } finally {
    await a.dispose();
    await b.dispose();
  }
});
it("records oversized and binary files without hashing them; excludes generated on request", async () => {
  const f = await fixture({
    "large.ts": "x".repeat(3000),
    "binary.ts": "\0hello",
    "generated.ts": "// @generated\nexport const g=1",
    ".codememory/config.json": JSON.stringify({ maxFileSizeBytes: 1024, excludeGenerated: true }),
  });
  try {
    const c = await createProjectContext(f.root);
    const scan = await new RepositoryScanner().scan(c);
    expect(scan.files.map((f) => f.status).sort()).toEqual(["SKIPPED_BINARY", "SKIPPED_TOO_LARGE"]);
  } finally {
    await f.dispose();
  }
});
it("selected monorepo subdirectory and worktree-like roots have distinct identities", async () => {
  const f = await fixture({
    ".git": "gitdir: /metadata",
    "apps/a/a.ts": "export const a=1",
    "apps/b/b.ts": "export const b=1",
  });
  try {
    const a = await createProjectContext(resolve(f.root, "apps/a")),
      b = await createProjectContext(resolve(f.root, "apps/b"));
    expect(a.canonicalRoot).toBe(resolve(f.root, "apps/a"));
    expect(a.projectScopeId).not.toBe(b.projectScopeId);
    expect((await new RepositoryScanner().scan(a)).files.map((f) => f.path)).toEqual(["a.ts"]);
  } finally {
    await f.dispose();
  }
});
it("rejects a symlinked application state directory before reading or creating config", async () => {
  const a = await fixture({ "main.ts": "" }),
    b = await fixture({});
  try {
    await symlink(b.root, resolve(a.root, ".codememory"));
    await expect(createProjectContext(a.root)).rejects.toMatchObject({ code: "PATH_OUT_OF_SCOPE" });
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

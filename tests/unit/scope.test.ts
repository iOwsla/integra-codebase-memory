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

it("prunes workflow scratch directories from scanning, watching and direct source reads", async () => {
  const { watchPolicy } = await import("../../packages/indexer/src/watch-policy");
  const f = await fixture({
    ".workflow-tmp/report.mjs": "broken 'report",
    "packages/app/.workflow-tmp/report.ts": "broken 'report",
    "src/report.ts": "export const report=1",
    "src/workflow-tmp.ts": "export const workflow=1",
  });
  try {
    const c = await createProjectContext(f.root);
    const visited: string[] = [];
    const scan = await new RepositoryScanner((_event, path) => visited.push(path)).scan(c);
    expect(scan.files.map((f) => f.path).sort()).toEqual(["src/report.ts", "src/workflow-tmp.ts"]);
    expect(visited.some((p) => p.includes(".workflow-tmp"))).toBe(false);
    expect(scan.exclusions.byReason.PROTECTED_PATH?.directories).toBe(2);
    const ignored = watchPolicy(c);
    expect(ignored(resolve(f.root, ".workflow-tmp/report.mjs"))).toBe(true);
    expect(ignored(resolve(f.root, "packages/app/.workflow-tmp/report.ts"))).toBe(true);
    expect(ignored(resolve(f.root, "src/report.ts"))).toBe(false);
    await expect(safePath(c, ".workflow-tmp/report.mjs")).rejects.toMatchObject({
      code: "PATH_OUT_OF_SCOPE",
    });
  } finally {
    await f.dispose();
  }
});

it("shares root codememoryignore rules between scanning and watching with local negations", async () => {
  const { watchPolicy } = await import("../../packages/indexer/src/watch-policy");
  const f = await fixture({
    ".codememoryignore": "scratch/\n*.report.ts\n!keep.report.ts\n!node_modules/\n!git-hidden.ts\n",
    ".gitignore": "git-hidden.ts\n",
    "scratch/broken.ts": "bad '",
    "drop.report.ts": "bad '",
    "keep.report.ts": "export const keep=1",
    "git-hidden.ts": "export const hidden=1",
    "node_modules/secret.ts": "export const dep=1",
    "src/main.ts": "export const main=1",
  });
  try {
    const c = await createProjectContext(f.root);
    const scan = await new RepositoryScanner().scan(c);
    expect(scan.files.map((f) => f.path).sort()).toEqual(["keep.report.ts", "src/main.ts"]);
    expect(scan.configs.has(".codememoryignore")).toBe(true);
    expect(scan.exclusions.byReason.CODEMEMORYIGNORE).toMatchObject({ files: 1, directories: 1 });
    const ignored = watchPolicy(c);
    for (const path of [
      "scratch/broken.ts",
      "drop.report.ts",
      "git-hidden.ts",
      "node_modules/secret.ts",
    ])
      expect(ignored(resolve(f.root, path))).toBe(true);
    expect(ignored(resolve(f.root, "keep.report.ts"))).toBe(false);
    expect(ignored(resolve(f.root, ".codememoryignore"))).toBe(false);
  } finally {
    await f.dispose();
  }
});

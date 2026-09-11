import { execFile } from "node:child_process";
import { resolve } from "node:path";
import { promisify } from "node:util";
import type { Snapshot } from "@codememory/core";
import { resolveSymbol, trace } from "@codememory/graph";
import { RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture } from "@codememory/test-utils";
import { expect, it } from "vitest";
import { watchPolicy } from "../../packages/indexer/src/watch-policy";

it("H: actual Git worktrees sharing metadata keep separate source identities", async () => {
  const f = await fixture({ "main.ts": "export const x=1" });
  const git = promisify(execFile);
  try {
    await git("git", ["init", f.root]);
    await git("git", ["-C", f.root, "add", "."]);
    await git("git", [
      "-C",
      f.root,
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "commit",
      "-m",
      "fixture",
    ]);
    await git("git", ["-C", f.root, "worktree", "add", "--detach", resolve(f.root, "checkout")]);
    const a = await createProjectContext(f.root),
      b = await createProjectContext(resolve(f.root, "checkout"));
    expect(a.projectScopeId).not.toBe(b.projectScopeId);
    expect((await new RepositoryScanner().scan(a)).files.map((f) => f.path)).toEqual(["main.ts"]);
    expect((await new RepositoryScanner().scan(b)).files.map((f) => f.path)).toEqual(["main.ts"]);
  } finally {
    await f.dispose();
  }
});
it("watcher prunes gitignored, nested, secret and state paths before descending", async () => {
  const f = await fixture({
    ".gitignore": "ignored/\n",
    "ignored/no.ts": "",
    "nested/.git": "gitdir: x",
    "nested/no.ts": "",
    "good/a.ts": "",
  });
  try {
    const c = await createProjectContext(f.root),
      ignored = watchPolicy(c);
    for (const path of ["ignored", "nested", "nested/no.ts", ".codememory", "node_modules", ".env"])
      expect(ignored(resolve(f.root, path)), path).toBe(true);
    expect(ignored(resolve(f.root, "good"))).toBe(false);
  } finally {
    await f.dispose();
  }
});
it("multiple tsconfigs, circular imports, destructuring and no-config source parsing", async () => {
  const f = await fixture({
    "a/tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@local":["./value.ts"]}}}',
    "a/value.ts": "import {entry} from './main'; export const value=()=>entry()",
    "a/main.ts":
      "import {value} from '@local'; export function entry(){const {x}= {x:1};return value?.()}",
    "b/tsconfig.json": '{"compilerOptions":{"baseUrl":".","paths":{"@local":["./value.ts"]}}}',
    "b/value.ts": "export const value=()=>2",
    "b/main.ts": "import {value} from '@local'; export function entry(){return value()}",
  });
  try {
    const c = await createProjectContext(f.root),
      scan = await new RepositoryScanner().scan(c),
      a = await new TypeScriptPlugin().analyze(c, scan.files, scan.configs);
    const snapshot: Snapshot = { ...a, ...scan, version: 1, indexedAt: null, fingerprint: "" };
    expect(() => resolveSymbol(snapshot, undefined, "entry")).toThrow(/id/);
    for (const folder of ["a", "b"]) {
      const source = a.symbols.find((s) => s.name === "entry" && s.file === `${folder}/main.ts`);
      const target = a.symbols.find((s) => s.name === "value" && s.file === `${folder}/value.ts`);
      expect(
        a.edges.some(
          (e) => e.type === "CALLS" && e.source === source?.id && e.target === target?.id,
        ),
      ).toBe(true);
    }
    const source = a.symbols.find((s) => s.name === "entry");
    const result = trace(snapshot, source?.id ?? "", "outgoing", 5, 3, ["CALLS"]);
    expect(result.paths.length).toBeLessThanOrEqual(3);
  } finally {
    await f.dispose();
  }
});

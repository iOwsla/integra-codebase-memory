import { mkdir, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import type { Analysis } from "@codememory/core";
import { RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture } from "@codememory/test-utils";
import { describe, expect, it } from "vitest";

const root = resolve("tests/fixtures/typescript/workspaces");
const calls = (a: Analysis, from: string, to: string) => {
  const source = a.symbols.find((s) => s.qualifiedName === from && s.kind === "FUNCTION"),
    target = a.symbols.find((s) => s.qualifiedName === to && s.kind === "FUNCTION");
  expect(source, from).toBeDefined();
  expect(target, to).toBeDefined();
  return a.edges.some(
    (e) => e.type === "CALLS" && e.source === source?.id && e.target === target?.id,
  );
};
describe("project configuration and workspace resolution", () => {
  it("resolves workspace exports with import/require conditions and wildcard subpaths", async () => {
    const c = await createProjectContext(root),
      s = await new RepositoryScanner().scan(c, new TypeScriptPlugin().configurationReferences),
      a = await new TypeScriptPlugin().analyze(c, s.files, s.configs);
    expect(calls(a, "web", "esm")).toBe(true);
    expect(calls(a, "web", "extra")).toBe(true);
    expect(calls(a, "node", "cjs")).toBe(true);
  });
  it("loads referenced custom config names and relative JSONC extends", async () => {
    const c = await createProjectContext(root),
      s = await new RepositoryScanner().scan(c, new TypeScriptPlugin().configurationReferences);
    expect(s.configs.has("packages/math/compiler.json")).toBe(true);
    expect(s.configs.has("packages/math/base.json")).toBe(true);
  });
  it("does not expand selected subprojects through workspace metadata or physical symlinks", async () => {
    const c = await createProjectContext(resolve(root, "apps/web")),
      seen: string[] = [];
    const s = await new RepositoryScanner((_event, path) => seen.push(path)).scan(
        c,
        new TypeScriptPlugin().configurationReferences,
      ),
      a = await new TypeScriptPlugin().analyze(c, s.files, s.configs);
    expect(s.files.map((f) => f.path)).toEqual(["main.mts"]);
    expect(a.symbols.some((s) => s.name === "esm" && s.kind === "FUNCTION")).toBe(false);
    expect(a.unresolved.some((u) => u.expression === "esm()")).toBe(true);
    expect(seen.every((p) => p.startsWith(c.canonicalRoot))).toBe(true);
  });
  it("does not read undeclared, excluded or symlinked workspace sources", async () => {
    const f = await fixture({
        "package.json": '{"workspaces":["packages/*"]}',
        ".gitignore": "packages/ignored/\n",
        "packages/ignored/package.json": '{"name":"hidden","exports":"./main.ts"}',
        "packages/ignored/main.ts": "export function hidden(){}",
        "rogue/package.json": '{"name":"rogue","exports":"./main.ts"}',
        "rogue/main.ts": "export function rogue(){}",
        "main.ts":
          "import {hidden} from 'hidden'; import {rogue} from 'rogue'; export function go(){hidden();rogue()}",
      }),
      b = await fixture({
        "package.json": '{"name":"outside","exports":"./main.ts"}',
        "main.ts": "export function outside(){}",
      });
    try {
      await mkdir(resolve(f.root, "node_modules"));
      await symlink(b.root, resolve(f.root, "node_modules/outside"));
      const c = await createProjectContext(f.root),
        s = await new RepositoryScanner().scan(c, new TypeScriptPlugin().configurationReferences),
        a = await new TypeScriptPlugin().analyze(c, s.files, s.configs);
      expect(a.edges.filter((e) => e.type === "CALLS")).toEqual([]);
    } finally {
      await f.dispose();
      await b.dispose();
    }
  });
});
it("redirects referenced declaration outputs to accepted source without reading build artifacts", async () => {
  const f = await fixture({
    "package.json": '{"workspaces":["lib","app"]}',
    "tsconfig.json":
      '{"files":[],"references":[{"path":"lib/compiler.json"},{"path":"app/tsconfig.json"}]}',
    "lib/package.json": '{"name":"lib","types":"./dist/index.d.ts"}',
    "lib/compiler.json":
      '{"compilerOptions":{"composite":true,"declaration":true,"rootDir":"src","outDir":"dist"},"include":["src"]}',
    "lib/src/index.ts": "export function api(){return 1}",
    "app/tsconfig.json":
      '{"compilerOptions":{"module":"NodeNext","moduleResolution":"NodeNext"},"references":[{"path":"../lib/compiler.json"}]}',
    "app/main.ts": "import {api} from 'lib'; export function run(){return api()}",
  });
  try {
    const c = await createProjectContext(f.root),
      plugin = new TypeScriptPlugin(),
      s = await new RepositoryScanner().scan(c, plugin.configurationReferences),
      a = await plugin.analyze(c, s.files, s.configs);
    expect(calls(a, "run", "api")).toBe(true);
    expect(a.symbols.every((s) => !s.file.includes("dist"))).toBe(true);
  } finally {
    await f.dispose();
  }
});
it("uses referenced custom configs for aliases and reports missing references without broadening scope", async () => {
  const f = await fixture({
    "tsconfig.json":
      '{"files":[],"references":[{"path":"./app/compiler.json"},{"path":"../outside"}]}',
    "app/compiler.json":
      '{"compilerOptions":{"baseUrl":".","paths":{"@api":["./api.ts"]}},"include":["*.ts"]}',
    "app/api.ts": "export function api(){return 1}",
    "app/main.ts": "import {api} from '@api';export function run(){return api()}",
  });
  try {
    const c = await createProjectContext(f.root),
      plugin = new TypeScriptPlugin(),
      s = await new RepositoryScanner().scan(c, plugin.configurationReferences),
      a = await plugin.analyze(c, s.files, s.configs);
    expect(calls(a, "run", "api")).toBe(true);
    expect(a.diagnostics.some((d) => d.message.includes("selected source scope"))).toBe(true);
  } finally {
    await f.dispose();
  }
});
it("respects blocked exports and refuses ambiguous duplicate workspace package names", async () => {
  const f = await fixture({
    "package.json": '{"workspaces":["packages/*"]}',
    "packages/a/package.json": '{"name":"dup","exports":"./main.ts"}',
    "packages/a/main.ts": "export function a(){}",
    "packages/b/package.json": '{"name":"dup","exports":"./main.ts"}',
    "packages/b/main.ts": "export function b(){}",
    "packages/locked/package.json":
      '{"name":"locked","exports":{".":"./index.ts","./private":null}}',
    "packages/locked/index.ts": "export function publicApi(){}",
    "packages/locked/private.ts": "export function privateApi(){}",
    "main.ts":
      "import {a} from 'dup';import {privateApi} from 'locked/private';export function run(){a();privateApi()}",
  });
  try {
    const c = await createProjectContext(f.root),
      s = await new RepositoryScanner().scan(c),
      a = await new TypeScriptPlugin().analyze(c, s.files, s.configs);
    expect(a.edges.filter((e) => e.type === "CALLS")).toEqual([]);
    expect(a.diagnostics.some((d) => d.message.includes("Ambiguous workspace"))).toBe(true);
  } finally {
    await f.dispose();
  }
});
it("locally declared require/module names do not create CommonJS module edges", async () => {
  const f = await fixture({
    "main.ts":
      "function require(name:string){return name};const module={exports:()=>0};function local(){return 1};module.exports=local;require('./other');",
    "other.ts": "export const other=1",
  });
  try {
    const c = await createProjectContext(f.root),
      s = await new RepositoryScanner().scan(c),
      a = await new TypeScriptPlugin().analyze(c, s.files, s.configs);
    const main = s.files.find((file) => file.path === "main.ts");
    expect(
      a.edges.some((e) => e.fileId === main?.id && (e.type === "IMPORTS" || e.type === "EXPORTS")),
    ).toBe(false);
    expect(a.symbols.find((s) => s.name === "local")?.exported).toBe(false);
  } finally {
    await f.dispose();
  }
});
it("metadata references never read ignored files or a sibling project, including absolute extends", async () => {
  const b = await fixture({ "base.json": '{"compilerOptions":{"baseUrl":"."}}' }),
    a = await fixture({
      "tsconfig.json": JSON.stringify({
        extends: resolve(b.root, "base.json"),
        references: [{ path: "./ignored/compiler.json" }],
      }),
      ".gitignore": "ignored/\n",
      "ignored/compiler.json": '{"compilerOptions":{}}',
      "source.ts": "export const source=1",
    });
  try {
    const c = await createProjectContext(a.root),
      paths: string[] = [],
      p = new TypeScriptPlugin(),
      s = await new RepositoryScanner((_event, path) => paths.push(path)).scan(
        c,
        p.configurationReferences,
      ),
      result = await p.analyze(c, s.files, s.configs);
    expect(paths.every((path) => path.startsWith(a.root))).toBe(true);
    expect(s.configs.has("ignored/compiler.json")).toBe(false);
    expect(result.diagnostics.length).toBeGreaterThan(0);
  } finally {
    await a.dispose();
    await b.dispose();
  }
});

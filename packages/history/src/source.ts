import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { ProjectContext } from "@codememory/core";
import { CodeMemoryError } from "@codememory/core";
import { prismaSourceLocators } from "@codememory/plugin-typescript";
import { contains, hash, safePath } from "@codememory/shared";
import ts from "typescript";
export async function readSource(context: ProjectContext, path: string, maxBytes: number) {
  let lexical = resolve(context.canonicalRoot, path);
  while (contains(context.canonicalRoot, lexical) && lexical !== context.canonicalRoot) {
    if ((await lstat(lexical)).isSymbolicLink())
      throw new CodeMemoryError("SYMLINK", "Source links are not followed");
    lexical = dirname(lexical);
  }
  const actual = await safePath(context, path);
  const file = await open(actual, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const before = await file.stat();
    if (!before.isFile())
      throw new CodeMemoryError("UNSUPPORTED_SOURCE", "Source is not a regular file");
    if (before.size > maxBytes)
      throw new CodeMemoryError("SKIPPED_TOO_LARGE", "Source exceeds configured byte limit");
    const buffer = Buffer.alloc(Math.min(before.size + 1, maxBytes + 1));
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    const after = await file.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || bytesRead !== before.size)
      throw new CodeMemoryError("SOURCE_CHANGED", "Source changed while reading; retry collection");
    return buffer.subarray(0, bytesRead);
  } finally {
    await file.close();
  }
}
export function decodeSource(bytes: Buffer) {
  if (bytes.includes(0))
    throw new CodeMemoryError("SKIPPED_BINARY", "Binary source is not text evidence");
  try {
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    throw new CodeMemoryError("UNSUPPORTED_ENCODING", "Source is not valid UTF-8");
  }
}
export function sourceLocators(path: string, bytes: Buffer) {
  const text = decodeSource(bytes);
  if (path.endsWith(".prisma")) return prismaSourceLocators(text);
  if (!/\.[cm]?[jt]sx?$/.test(path))
    return {
      locators: [] as { name: string; startLine: number; endLine: number; hash: string }[],
      coverage: "TEXT_ONLY",
    };
  const file = ts.createSourceFile(path, text, ts.ScriptTarget.Latest, true);
  const locators: { name: string; startLine: number; endLine: number; hash: string }[] = [];
  const walk = (node: ts.Node) => {
    if (locators.length >= 100) return;
    if (
      ts.isFunctionDeclaration(node) ||
      ts.isClassDeclaration(node) ||
      ts.isMethodDeclaration(node) ||
      ts.isVariableDeclaration(node)
    ) {
      if (node.name)
        locators.push({
          name: node.name.getText(file).slice(0, 200),
          startLine: file.getLineAndCharacterOfPosition(node.getStart(file)).line + 1,
          endLine: file.getLineAndCharacterOfPosition(node.getEnd()).line + 1,
          hash: hash(node.getText(file)),
        });
    }
    ts.forEachChild(node, walk);
  };
  walk(file);
  const diagnostics =
    (file as ts.SourceFile & { parseDiagnostics?: unknown[] }).parseDiagnostics ?? [];
  return {
    locators,
    coverage: diagnostics.length
      ? "PARSE_ERRORS"
      : locators.length >= 100
        ? "LOCATORS_TRUNCATED"
        : "SYNTACTIC_ONLY",
  };
}

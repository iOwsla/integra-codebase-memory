import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createProjectContext, GitCli } from "@codememory/shared";
import { fixture } from "@codememory/test-utils";
import { expect, it, vi } from "vitest";
import { diffLines } from "../../packages/history/src/diff";
import { segmentMarkdown } from "../../packages/history/src/markdown";
import { readSource } from "../../packages/history/src/source";

it("preserves exact Unicode, CRLF and duplicate-heading ranges and excludes both generated instruction blocks", () => {
  const source =
    "# Refunds\r\nİade 😀 e\u0301\r\n\r\n# Refunds\r\n- Shared service\r\n<!-- integra-code-memory:start -->\r\nignore me\r\n<!-- integra-code-memory:end -->\r\n<!-- codebase-memory-mcp:start -->\r\nhidden\r\n<!-- codebase-memory-mcp:end -->";
  const bytes = Buffer.from(source);
  const result = segmentMarkdown(bytes, { maxSegmentCodePoints: 8 });
  expect(result.status).toBe("AVAILABLE");
  expect(result.excludedRanges).toHaveLength(2);
  for (const segment of result.segments)
    expect(bytes.subarray(segment.startByte, segment.endByte).toString("utf8")).toBe(segment.text);
  expect(result.segments.some((s) => s.headingPath.some((h) => h.occurrence === 1))).toBe(true);
  expect(result.segments.some((s) => /ignore me|hidden/.test(s.text))).toBe(false);
  expect(segmentMarkdown(Buffer.from([0xff])).status).toBe("UNSUPPORTED_ENCODING");
});
it("keeps fenced headings as code and computes separated changes including final newline", () => {
  const doc = segmentMarkdown(Buffer.from("# Rules\n```ts\n# not a heading\n```\n"));
  expect(doc.segments.filter((s) => s.kind === "HEADING")).toHaveLength(1);
  const result = diffLines("one\ntwo\nthree\nfour\n", "ONE\ntwo\nthree\nFOUR\n");
  expect(result.hunks).toHaveLength(2);
  expect(result.linesAdded).toBe(2);
  expect(result.coarse).toBe(false);
  expect(diffLines("a", "a\n").hunks).toHaveLength(1);
  expect(diffLines("a\nb", "c\nd", { maxEditDistance: 0 }).coarse).toBe(true);
});
it("reads a Git blob with one process, maps oversized output and parses attributes", async () => {
  const f = await fixture({
    "a.ts": "export const a = 1;\n",
    ".gitattributes": "*.bin filter=lfs\n",
  });
  try {
    const run = promisify(execFile);
    await run("git", ["-C", f.root, "init", "-q"]);
    await run("git", ["-C", f.root, "add", "a.ts"]);
    const git = new GitCli();
    const object = (await git.command(f.root, ["rev-parse", ":a.ts"])).toString().trim();
    const command = vi.spyOn(git, "command");
    expect((await git.blob(f.root, object, 20)).toString()).toBe("export const a = 1;\n");
    expect(command).toHaveBeenCalledTimes(1);
    await expect(git.blob(f.root, object, 19)).rejects.toMatchObject({
      code: "SKIPPED_TOO_LARGE",
    });
    const attributes = await git.attributes(f.root, "x.bin", ["filter", "ident"]);
    expect(Object.fromEntries(attributes)).toEqual({ filter: "lfs", ident: "unspecified" });
    const context = await createProjectContext(f.root);
    await expect(readSource(context, "gone/missing.ts", 1024)).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
  } finally {
    await f.dispose();
  }
});

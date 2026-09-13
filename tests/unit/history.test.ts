import { expect, it } from "vitest";
import { diffLines } from "../../packages/history/src/diff";
import { segmentMarkdown } from "../../packages/history/src/markdown";

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

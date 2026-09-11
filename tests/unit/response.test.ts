import { response } from "@codememory/mcp-server";
import { expect, it } from "vitest";

it("shrinks oversized pages without losing records or conflating response size with index coverage", () => {
  const all = Array.from({ length: 107 }, (_, id) => ({ id, signature: "x".repeat(2000) }));
  const seen: number[] = [];
  let offset = 0;
  while (offset < all.length) {
    const input = all.slice(offset, offset + 100);
    const result = response(
      {
        results: input,
        incomplete: false,
        hasMore: offset + 100 < all.length,
        nextOffset: offset + 100,
      },
      offset,
    );
    expect(Buffer.byteLength(result.content[0]!.text)).toBeLessThanOrEqual(65536);
    expect(result.structuredContent.incomplete).toBe(false);
    const rows = result.structuredContent.results as { id: number }[];
    seen.push(...rows.map((row) => row.id));
    if (!result.structuredContent.hasMore) break;
    expect(result.structuredContent.nextOffset).toBe(offset + rows.length);
    offset = Number(result.structuredContent.nextOffset);
  }
  expect(seen).toEqual(all.map((row) => row.id));
});

it("returns a distinct size error and suggested limit for an oversized single record", () => {
  const result = response({ results: [{ value: "x".repeat(70000) }], incomplete: false });
  expect(result.isError).toBe(true);
  expect(result.structuredContent).toMatchObject({
    incomplete: false,
    responseTruncated: true,
    error: { code: "RESPONSE_TOO_LARGE", suggestedLimit: 1 },
  });
});

it("returns a failed index status as a readable status rather than a tool execution error", () => {
  const result = response({ state: "ERROR", error: "PARSER_ERROR", incomplete: false });
  expect(result.isError).toBeUndefined();
  expect(result.structuredContent.error).toBe("PARSER_ERROR");
});

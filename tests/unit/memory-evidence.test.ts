import { expect, it } from "vitest";
import { evidenceSegments, resolveEvidence } from "../../packages/memory/src/evidence";

it("preserves Turkish spelling, CRLF, combining marks and emoji without model-authored quotes", () => {
  const text = `İadeyi inbout olarak yazdım; değiştirme.\r\n${"😀şIıİe\u0301".repeat(400)}`;
  const batch = {
    sessionId: "s",
    batchId: "b",
    messages: [{ id: "original", role: "user" as const, text }],
  };
  const segments = evidenceSegments(batch);
  expect(segments.map((s) => s.text).join("")).toBe(text);
  expect(evidenceSegments(batch)).toEqual(segments);
  const resolved = resolveEvidence(
    [
      {
        id: "c",
        claim: "Preserve the original spelling.",
        classification: "REQUIREMENT",
        evidenceIds: [segments[0]!.evidenceId],
      },
    ],
    segments,
  );
  expect(resolved[0]?.evidence[0]).toEqual({ messageId: "original", quote: segments[0]!.text });
  expect(text.includes(resolved[0]!.evidence[0]!.quote)).toBe(true);
});
it("rejects unknown or repeated evidence IDs without echoing untrusted payloads", () => {
  const candidate = {
    id: "private",
    claim: "private",
    classification: "REQUIREMENT",
    evidenceIds: ["private-unknown"],
  };
  expect(() => resolveEvidence([candidate], [])).toThrow(
    "Candidate 1, evidence 1: unknown evidence ID",
  );
  expect(() => resolveEvidence([{ ...candidate, evidenceIds: ["same", "same"] }], [])).toThrow(
    "duplicate evidence selection",
  );
});

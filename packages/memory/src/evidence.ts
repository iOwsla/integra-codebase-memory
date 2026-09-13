import { CodeMemoryError, type MemoryBatch } from "@codememory/core";

/** Deterministic, lossless chunks. Never translate, trim or normalize evidence. */
export function evidenceSegments(batch: MemoryBatch) {
  const segments: {
    evidenceId: string;
    messageId: string;
    role: "user" | "assistant";
    text: string;
  }[] = [];
  for (const [messageIndex, message] of batch.messages.entries()) {
    const points = Array.from(message.text);
    for (let start = 0; start < points.length; start += 800)
      segments.push({
        evidenceId: `m${messageIndex}s${start / 800}`,
        messageId: message.id,
        role: message.role,
        text: points.slice(start, start + 800).join(""),
      });
  }
  return segments;
}
export function resolveEvidence(
  candidates: { id: string; claim: string; classification: string; evidenceIds: string[] }[],
  segments: ReturnType<typeof evidenceSegments>,
) {
  const byId = new Map(segments.map((s) => [s.evidenceId, s]));
  return candidates.map(({ evidenceIds, ...candidate }, candidateIndex) => {
    if (new Set(evidenceIds).size !== evidenceIds.length)
      throw new CodeMemoryError(
        "INVALID_EVIDENCE",
        `Candidate ${candidateIndex + 1}: duplicate evidence selection`,
      );
    return {
      ...candidate,
      evidence: evidenceIds.map((id, evidenceIndex) => {
        const segment = byId.get(id);
        if (!segment)
          throw new CodeMemoryError(
            "INVALID_EVIDENCE",
            `Candidate ${candidateIndex + 1}, evidence ${evidenceIndex + 1}: unknown evidence ID; select an ID from this batch`,
          );
        return { messageId: segment.messageId, quote: segment.text };
      }),
    };
  });
}

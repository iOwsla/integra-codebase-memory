import type { Snapshot } from "@codememory/core";
export function searchSymbols(
  snapshot: Snapshot,
  query: string,
  limit = 20,
  offset = 0,
  kinds: string[] = [],
) {
  const q = query.toLowerCase();
  const filesById = new Map(snapshot.files.map((f) => [f.id, f]));
  const grams = (s: string) =>
    new Set(Array.from({ length: Math.max(0, s.length - 2) }, (_, i) => s.slice(i, i + 3)));
  const qg = grams(q);
  const hits = snapshot.symbols
    .filter((s) => !kinds.length || kinds.includes(s.kind))
    .map((s) => {
      const name = s.name.toLowerCase(),
        qualified = s.qualifiedName.toLowerCase();
      let score = 0,
        reason = "";
      if (name === q) {
        score = 100;
        reason = "exact name";
      } else if (qualified === q) {
        score = 95;
        reason = "qualified name";
      } else if (name.startsWith(q)) {
        score = 80;
        reason = "prefix";
      } else if (name.includes(q)) {
        score = 65;
        reason = "substring";
      } else {
        const g = grams(name);
        const overlap = [...qg].filter((t) => g.has(t)).length;
        const similarity = (2 * overlap) / (qg.size + g.size || 1);
        if (similarity >= 0.3) {
          score = 50 * similarity;
          reason = "trigram";
        }
      }
      if (s.kind === "IMPORT" || s.kind === "EXPORT") {
        score *= 0.6;
        reason += "; alias declaration";
      }
      const file = filesById.get(s.fileId);
      if (file?.generated) {
        score *= 0.5;
        reason += "; generated penalty";
      }
      return { ...s, score, reason };
    })
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score || a.file.localeCompare(b.file) || a.startLine - b.startLine);
  return {
    results: hits.slice(offset, offset + limit),
    hasMore: hits.length > offset + limit,
    nextOffset: offset + limit,
  };
}
export function searchCode(snapshot: Snapshot, query: string, limit = 20, offset = 0) {
  const results: { file: string; line: number; snippet: string; score: number; reason: string }[] =
    [];
  let count = 0;
  for (const file of snapshot.files) {
    if (file.status !== "INDEXED") continue;
    const lines = file.content.split(/\r?\n/);
    for (let i = 0; i < lines.length; i++) {
      if (!lines[i]?.toLowerCase().includes(query.toLowerCase())) continue;
      if (count++ < offset) continue;
      if (results.length === limit) return { results, hasMore: true, nextOffset: offset + limit };
      results.push({
        file: file.path,
        line: i + 1,
        snippet: (lines[i] ?? "").slice(0, 500),
        score: file.generated ? 0.5 : 1,
        reason: "lexical substring",
      });
    }
  }
  return { results, hasMore: false, nextOffset: offset + limit };
}

import { CodeMemoryError, type CodeSymbol, type Snapshot } from "@codememory/core";
export function resolveSymbol(snapshot: Snapshot, symbolId?: string, name?: string): CodeSymbol {
  const found = symbolId
    ? snapshot.symbols.filter((s) => s.id === symbolId)
    : snapshot.symbols.filter(
        (s) =>
          (s.name === name || s.qualifiedName === name) &&
          s.kind !== "IMPORT" &&
          s.kind !== "EXPORT",
      );
  if (!found.length) throw new CodeMemoryError("NOT_FOUND", "Symbol not found in selected project");
  if (found.length > 1)
    throw new CodeMemoryError(
      "AMBIGUOUS_SYMBOL",
      JSON.stringify(
        found.slice(0, 20).map((s) => ({ id: s.id, file: s.file, name: s.qualifiedName })),
      ),
    );
  return found[0] as CodeSymbol;
}
export function relationships(
  snapshot: Snapshot,
  symbolId: string,
  direction: "incoming" | "outgoing",
  type?: string,
  limit = 20,
  offset = 0,
) {
  resolveSymbol(snapshot, symbolId);
  const all = snapshot.edges.filter(
    (e) =>
      (direction === "incoming" ? e.target : e.source) === symbolId && (!type || e.type === type),
  );
  const symbols = new Map(snapshot.symbols.map((s) => [s.id, s]));
  return {
    results: all
      .slice(offset, offset + limit)
      .map((e) => ({ ...e, symbol: symbols.get(direction === "incoming" ? e.source : e.target) })),
    hasMore: all.length > offset + limit,
    nextOffset: offset + limit,
  };
}
export function trace(
  snapshot: Snapshot,
  from: string,
  direction: "incoming" | "outgoing",
  maxDepth = 3,
  maxPaths = 20,
  types: string[] = [],
) {
  resolveSymbol(snapshot, from);
  const paths: string[][] = [];
  const queue: string[][] = [[from]];
  const adjacency = new Map<string, string[]>();
  for (const e of snapshot.edges) {
    if (types.length && !types.includes(e.type)) continue;
    const a = direction === "incoming" ? e.target : e.source,
      b = direction === "incoming" ? e.source : e.target;
    adjacency.set(a, [...(adjacency.get(a) ?? []), b]);
  }
  let truncated = false;
  let steps = 0;
  while (queue.length && paths.length < maxPaths && steps++ < 10000) {
    const path = queue.shift() as string[];
    const last = path[path.length - 1] as string;
    const next = [...new Set(adjacency.get(last) ?? [])].filter((n) => !path.includes(n));
    if (path.length > maxDepth || !next.length) {
      paths.push(path);
      continue;
    }
    for (const n of next) {
      if (queue.length >= 1000) {
        truncated = true;
        break;
      }
      queue.push([...path, n]);
    }
  }
  return { paths, truncated: truncated || queue.length > 0 };
}

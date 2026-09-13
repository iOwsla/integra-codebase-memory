/** Bounded line diff with Git `--unified=0` hunk conventions. Pure and deterministic. */
export interface LineHunk {
  /** For a pure insertion, the old line after which lines were inserted (0 at file start). */
  oldStart: number;
  oldLines: number;
  /** For a pure deletion, the new line after which lines were removed (0 at file start). */
  newStart: number;
  newLines: number;
}
export interface LineDiff {
  hunks: LineHunk[];
  linesAdded: number;
  linesDeleted: number;
  hunksTruncated: boolean;
  /** The edit distance exceeded its budget; one hunk covers the changed middle region. */
  coarse: boolean;
}

/** Lines keep their terminators, so a missing final newline is a real difference as in Git. */
export function splitLines(text: string): string[] {
  const lines: string[] = [];
  let from = 0;
  while (from < text.length) {
    const newline = text.indexOf("\n", from);
    if (newline === -1) {
      lines.push(text.slice(from));
      break;
    }
    lines.push(text.slice(from, newline + 1));
    from = newline + 1;
  }
  return lines;
}

/** Myers O((N+M)D) search; returns matched index pairs, or null beyond the edit budget. */
function matches(a: Int32Array, b: Int32Array, budget: number): [number, number][] | null {
  const n = a.length;
  const m = b.length;
  const limit = Math.min(budget, n + m);
  const offset = limit + 1;
  const v = new Int32Array(2 * limit + 3);
  const trace: Int32Array[] = [];
  for (let d = 0; d <= limit; d++) {
    trace.push(v.slice(offset - d - 1, offset + d + 2));
    for (let k = -d; k <= d; k += 2) {
      const down = k === -d || (k !== d && (v[offset + k - 1] ?? 0) < (v[offset + k + 1] ?? 0));
      let x = down ? (v[offset + k + 1] ?? 0) : (v[offset + k - 1] ?? 0) + 1;
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) return backtrack(trace, n, m);
    }
  }
  return null;
}

function backtrack(trace: Int32Array[], n: number, m: number) {
  const pairs: [number, number][] = [];
  let x = n;
  let y = m;
  for (let d = trace.length - 1; d > 0; d--) {
    const previous = trace[d];
    if (!previous) break;
    const at = (k: number) => previous[k + d + 1] ?? 0;
    const k = x - y;
    const priorK = k === -d || (k !== d && at(k - 1) < at(k + 1)) ? k + 1 : k - 1;
    const priorX = at(priorK);
    const priorY = priorX - priorK;
    while (x > priorX && y > priorY) {
      x--;
      y--;
      pairs.push([x, y]);
    }
    x = priorX;
    y = priorY;
  }
  while (x > 0 && y > 0) {
    x--;
    y--;
    pairs.push([x, y]);
  }
  return pairs.reverse();
}

const hunk = (
  prefix: number,
  oldFrom: number,
  oldTo: number,
  newFrom: number,
  newTo: number,
): LineHunk => ({
  oldStart: prefix + oldFrom + (oldTo > oldFrom ? 1 : 0),
  oldLines: oldTo - oldFrom,
  newStart: prefix + newFrom + (newTo > newFrom ? 1 : 0),
  newLines: newTo - newFrom,
});

export function diffLines(
  oldText: string,
  newText: string,
  options: { maxEditDistance?: number; maxHunks?: number } = {},
): LineDiff {
  const maxHunks = options.maxHunks ?? 1000;
  const a = splitLines(oldText);
  const b = splitLines(newText);
  let prefix = 0;
  while (prefix < a.length && prefix < b.length && a[prefix] === b[prefix]) prefix++;
  let suffix = 0;
  while (
    suffix < a.length - prefix &&
    suffix < b.length - prefix &&
    a[a.length - 1 - suffix] === b[b.length - 1 - suffix]
  )
    suffix++;
  const oldMiddle = a.slice(prefix, a.length - suffix);
  const newMiddle = b.slice(prefix, b.length - suffix);
  const ids = new Map<string, number>();
  const intern = (line: string) => {
    let value = ids.get(line);
    if (value === undefined) {
      value = ids.size;
      ids.set(line, value);
    }
    return value;
  };
  const x = Int32Array.from(oldMiddle, intern);
  const y = Int32Array.from(newMiddle, intern);
  let hunks: LineHunk[] = [];
  let coarse = false;
  if (x.length || y.length) {
    const pairs = matches(x, y, options.maxEditDistance ?? 2000);
    if (!pairs) {
      coarse = true;
      hunks.push(hunk(prefix, 0, x.length, 0, y.length));
    } else {
      let i = 0;
      let j = 0;
      for (const [mi, mj] of [...pairs, [x.length, y.length] as [number, number]]) {
        if (mi > i || mj > j) hunks.push(hunk(prefix, i, mi, j, mj));
        i = mi + 1;
        j = mj + 1;
      }
    }
  }
  const linesAdded = hunks.reduce((sum, h) => sum + h.newLines, 0);
  const linesDeleted = hunks.reduce((sum, h) => sum + h.oldLines, 0);
  const hunksTruncated = hunks.length > maxHunks;
  if (hunksTruncated) hunks = hunks.slice(0, maxHunks);
  return { hunks, linesAdded, linesDeleted, hunksTruncated, coarse };
}

/** Whether a hunk changes lines inside an inclusive 1-based range on one side. */
export function hunkTouches(
  change: LineHunk,
  side: "old" | "new",
  startLine: number,
  endLine: number,
) {
  const start = side === "old" ? change.oldStart : change.newStart;
  const lines = side === "old" ? change.oldLines : change.newLines;
  // An insertion or deletion point inside the range changes the range's content.
  if (!lines) return start >= startLine && start < endLine;
  return start <= endLine && start + lines - 1 >= startLine;
}

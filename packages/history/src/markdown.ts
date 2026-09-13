/**
 * Deterministic Markdown evidence segmentation. Document text is untrusted data: nothing is
 * rendered, executed or followed. Positions are exact UTF-8 byte ranges and 1-based lines.
 */
export const MARKDOWN_SEGMENTER = "markdown-1";
export const INSTRUCTION_MARKERS: readonly { start: string; end: string }[] = [
  { start: "<!-- integra-code-memory:start -->", end: "<!-- integra-code-memory:end -->" },
  { start: "<!-- codebase-memory-mcp:start -->", end: "<!-- codebase-memory-mcp:end -->" },
];
export type MarkdownBlockKind =
  | "FRONT_MATTER"
  | "HEADING"
  | "PARAGRAPH"
  | "LIST"
  | "TABLE"
  | "BLOCK_QUOTE"
  | "CODE_FENCE"
  | "CODE_INDENTED"
  | "HTML";
export interface HeadingRef {
  text: string;
  depth: number;
  /** Earlier headings with the same parent path, depth and text; keeps duplicates distinct. */
  occurrence: number;
}
export interface MarkdownSegment {
  ordinal: number;
  kind: MarkdownBlockKind;
  startLine: number;
  endLine: number;
  /** Inclusive start and exclusive end; the final line terminator is excluded. */
  startByte: number;
  endByte: number;
  headingPath: HeadingRef[];
  text: string;
  part: number;
  parts: number;
}
export interface MarkdownDocument {
  status: "AVAILABLE" | "UNSUPPORTED_ENCODING";
  lineCount: number;
  segments: MarkdownSegment[];
  excludedRanges: {
    startLine: number;
    endLine: number;
    reason: "INSTRUCTION_BLOCK" | "UNCLOSED_INSTRUCTION_BLOCK";
  }[];
}
interface Line {
  text: string;
  from: number;
  to: number;
  start: number;
  end: number;
}
interface Block {
  kind: MarkdownBlockKind;
  first: number;
  last: number;
  heading?: { text: string; depth: number };
}
type Piece = Pick<MarkdownSegment, "startLine" | "endLine" | "startByte" | "endByte" | "text">;

const fence = /^ {0,3}(`{3,}|~{3,})(.*)$/;
const fenceClose = /^ {0,3}(`{3,}|~{3,})[ \t]*$/;
const atx = /^ {0,3}(#{1,6})(?:[ \t]+(.*))?$/;
const setext = /^ {0,3}(?:=+|-+)[ \t]*$/;
const thematic = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const listItem = /^ {0,3}(?:[-+*]|\d{1,9}[.)])(?:[ \t]|$)/;
const quote = /^ {0,3}>/;
const html = /^ {0,3}<(?:!--|[?!]|\/?[A-Za-z][A-Za-z0-9-]*(?:[\s/>]|$))/;
const tableDelimiter = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const indentedCode = /^(?: {4}|\t)/;
const blank = (text: string) => /^[ \t]*$/.test(text);

function indentation(text: string) {
  let width = 0;
  for (const character of text) {
    if (character === " ") width++;
    else if (character === "\t") width += 4 - (width % 4);
    else break;
  }
  return width;
}
function openFence(text: string) {
  const match = fence.exec(text);
  const marker = match?.[1];
  if (!marker || (marker.startsWith("`") && (match[2] ?? "").includes("`"))) return null;
  return marker;
}
function closesFence(text: string, marker: string) {
  const close = fenceClose.exec(text)?.[1];
  return !!close && close[0] === marker[0] && close.length >= marker.length;
}
const utf8Length = (codePoint: number) =>
  codePoint < 0x80 ? 1 : codePoint < 0x800 ? 2 : codePoint < 0x10000 ? 3 : 4;

function splitLines(source: string): Line[] {
  const lines: Line[] = [];
  let from = 0;
  let byte = 0;
  while (from < source.length) {
    const newline = source.indexOf("\n", from);
    const stop = newline === -1 ? source.length : newline;
    const to = stop > from && source.charCodeAt(stop - 1) === 13 ? stop - 1 : stop;
    const text = source.slice(from, to);
    const bytes = Buffer.byteLength(text, "utf8");
    lines.push({ text, from, to, start: byte, end: byte + bytes });
    byte += bytes + (stop - to) + (newline === -1 ? 0 : 1);
    if (newline === -1) break;
    from = newline + 1;
  }
  const first = lines[0];
  // A byte-order mark is an encoding signature, not document content.
  if (first?.text.startsWith("﻿")) {
    first.text = first.text.slice(1);
    first.from += 1;
    first.start += 3;
  }
  return lines;
}

function headingText(raw: string) {
  return raw
    .replace(/(?:^|[ \t]+)#+[ \t]*$/, "")
    .trim()
    .replace(/[ \t]+/g, " ");
}

function parseBlocks(
  lines: Line[],
  markers: readonly { start: string; end: string }[],
  excluded: MarkdownDocument["excludedRanges"],
) {
  const blocks: Block[] = [];
  const count = lines.length;
  const text = (index: number) => lines[index]?.text ?? "";
  const marker = (value: string) => markers.find((m) => value.trim() === m.start);
  const interrupts = (value: string) =>
    !!openFence(value) ||
    atx.test(value) ||
    quote.test(value) ||
    html.test(value) ||
    thematic.test(value) ||
    listItem.test(value) ||
    !!marker(value);
  let index = 0;
  if (count > 1 && /^---[ \t]*$/.test(text(0)))
    for (let close = 1; close < count; close++)
      if (/^(?:---|\.\.\.)[ \t]*$/.test(text(close))) {
        blocks.push({ kind: "FRONT_MATTER", first: 0, last: close });
        index = close + 1;
        break;
      }
  while (index < count) {
    const current = text(index);
    if (blank(current)) {
      index++;
      continue;
    }
    const instruction = marker(current);
    if (instruction) {
      let end = index + 1;
      while (end < count && text(end).trim() !== instruction.end) end++;
      excluded.push({
        startLine: index + 1,
        endLine: Math.min(end, count - 1) + 1,
        reason: end < count ? "INSTRUCTION_BLOCK" : "UNCLOSED_INSTRUCTION_BLOCK",
      });
      index = end + 1;
      continue;
    }
    const fenceMarker = openFence(current);
    if (fenceMarker) {
      let end = index + 1;
      while (end < count && !closesFence(text(end), fenceMarker)) end++;
      const last = Math.min(end, count - 1);
      blocks.push({ kind: "CODE_FENCE", first: index, last });
      index = last + 1;
      continue;
    }
    const heading = atx.exec(current);
    if (heading) {
      blocks.push({
        kind: "HEADING",
        first: index,
        last: index,
        heading: { depth: (heading[1] ?? "#").length, text: headingText(heading[2] ?? "") },
      });
      index++;
      continue;
    }
    if (thematic.test(current)) {
      index++;
      continue;
    }
    if (html.test(current)) {
      let end = index;
      if (/^ {0,3}<!--/.test(current)) while (end < count && !text(end).includes("-->")) end++;
      else while (end + 1 < count && !blank(text(end + 1))) end++;
      const last = Math.min(end, count - 1);
      blocks.push({ kind: "HTML", first: index, last });
      index = last + 1;
      continue;
    }
    if (quote.test(current)) {
      let end = index;
      while (
        end + 1 < count &&
        (quote.test(text(end + 1)) || (!blank(text(end + 1)) && !interrupts(text(end + 1))))
      )
        end++;
      blocks.push({ kind: "BLOCK_QUOTE", first: index, last: end });
      index = end + 1;
      continue;
    }
    if (listItem.test(current)) {
      let end = index;
      while (end + 1 < count) {
        const next = text(end + 1);
        if (blank(next)) {
          let resume = end + 2;
          while (resume < count && blank(text(resume))) resume++;
          const candidate = text(resume);
          if (
            resume < count &&
            !thematic.test(candidate) &&
            (listItem.test(candidate) || indentation(candidate) >= 2)
          ) {
            end = resume;
            continue;
          }
          break;
        }
        if (thematic.test(next)) break;
        if (listItem.test(next) || indentation(next) >= 2) {
          end++;
          continue;
        }
        if (interrupts(next)) break;
        end++;
      }
      blocks.push({ kind: "LIST", first: index, last: end });
      index = end + 1;
      continue;
    }
    if (indentedCode.test(current)) {
      let end = index;
      while (end + 1 < count && (indentedCode.test(text(end + 1)) || blank(text(end + 1)))) end++;
      while (end > index && blank(text(end))) end--;
      blocks.push({ kind: "CODE_INDENTED", first: index, last: end });
      index = end + 1;
      continue;
    }
    if (current.includes("|") && tableDelimiter.test(text(index + 1)) && index + 1 < count) {
      let end = index + 1;
      while (end + 1 < count && !blank(text(end + 1)) && text(end + 1).includes("|")) end++;
      blocks.push({ kind: "TABLE", first: index, last: end });
      index = end + 1;
      continue;
    }
    let end = index;
    let depth = 0;
    while (end + 1 < count) {
      const next = text(end + 1);
      if (blank(next)) break;
      if (setext.test(next)) {
        depth = next.trim().startsWith("=") ? 1 : 2;
        end++;
        break;
      }
      if (interrupts(next)) break;
      end++;
    }
    if (depth) {
      const title = lines
        .slice(index, end)
        .map((line) => line.text.trim())
        .join(" ");
      blocks.push({
        kind: "HEADING",
        first: index,
        last: end,
        heading: { depth, text: headingText(title) },
      });
    } else blocks.push({ kind: "PARAGRAPH", first: index, last: end });
    index = end + 1;
  }
  return blocks;
}

function pieces(source: string, lines: Line[], first: number, last: number, limit: number) {
  const result: Piece[] = [];
  let start = first;
  let size = 0;
  const flush = (end: number) => {
    const a = lines[start];
    const b = lines[end];
    if (!a || !b) return;
    result.push({
      startLine: start + 1,
      endLine: end + 1,
      startByte: a.start,
      endByte: b.end,
      text: source.slice(a.from, b.to),
    });
  };
  for (let index = first; index <= last; index++) {
    const line = lines[index];
    if (!line) break;
    let points = 0;
    for (const _ of line.text) points++;
    if (points > limit) {
      if (index > start) flush(index - 1);
      // One oversized line is split on code-point boundaries; byte ranges stay exact.
      let chunkChar = 0;
      let chunkByte = 0;
      let char = 0;
      let byte = 0;
      let chunkPoints = 0;
      for (const character of line.text) {
        if (chunkPoints === limit) {
          result.push({
            startLine: index + 1,
            endLine: index + 1,
            startByte: line.start + chunkByte,
            endByte: line.start + byte,
            text: line.text.slice(chunkChar, char),
          });
          chunkChar = char;
          chunkByte = byte;
          chunkPoints = 0;
        }
        char += character.length;
        byte += utf8Length(character.codePointAt(0) ?? 0);
        chunkPoints++;
      }
      result.push({
        startLine: index + 1,
        endLine: index + 1,
        startByte: line.start + chunkByte,
        endByte: line.end,
        text: line.text.slice(chunkChar),
      });
      start = index + 1;
      size = 0;
      continue;
    }
    if (size + points + 1 > limit && index > start) {
      flush(index - 1);
      start = index;
      size = 0;
    }
    size += points + 1;
  }
  if (start <= last) flush(last);
  return result;
}

export function segmentMarkdown(
  bytes: Uint8Array,
  options: {
    maxSegmentCodePoints?: number;
    markers?: readonly { start: string; end: string }[];
  } = {},
): MarkdownDocument {
  let source: string;
  try {
    source = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(bytes);
  } catch {
    return { status: "UNSUPPORTED_ENCODING", lineCount: 0, segments: [], excludedRanges: [] };
  }
  const limit = Math.max(1, options.maxSegmentCodePoints ?? 1200);
  const lines = splitLines(source);
  const excludedRanges: MarkdownDocument["excludedRanges"] = [];
  const blocks = parseBlocks(lines, options.markers ?? INSTRUCTION_MARKERS, excludedRanges);
  const segments: MarkdownSegment[] = [];
  const stack: HeadingRef[] = [];
  const seen = new Map<string, number>();
  for (const block of blocks) {
    if (block.heading) {
      const { depth, text } = block.heading;
      while ((stack.at(-1)?.depth ?? 0) >= depth) stack.pop();
      const key = JSON.stringify([stack, depth, text]);
      const occurrence = seen.get(key) ?? 0;
      seen.set(key, occurrence + 1);
      stack.push({ text, depth, occurrence });
    }
    const parts = pieces(source, lines, block.first, block.last, limit);
    parts.forEach((piece, index) => {
      segments.push({
        ordinal: segments.length,
        kind: block.kind,
        ...piece,
        headingPath: stack.map((heading) => ({ ...heading })),
        part: index + 1,
        parts: parts.length,
      });
    });
  }
  return { status: "AVAILABLE", lineCount: lines.length, segments, excludedRanges };
}

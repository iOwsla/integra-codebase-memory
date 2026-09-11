import {
  CodeMemoryError,
  type CodeSymbol,
  type IndexReader,
  type PageRequest,
  type SymbolSelector,
} from "@codememory/core";
import type pg from "pg";

const literalPattern = (text: string) => text.replace(/[\\%_]/g, "\\$&");
const pageResult = <T>(rows: T[], page: PageRequest) => ({
  results: rows.slice(0, page.limit),
  hasMore: rows.length > page.limit,
  nextOffset: page.offset + page.limit,
});

/** No query accepts a caller-selected repository; this reader is transaction-owned. */
export class PostgresIndexReader implements IndexReader {
  private active = true;
  constructor(
    private readonly connection: pg.PoolClient,
    private readonly scope: string,
  ) {}
  close() {
    this.active = false;
  }
  private async query<T extends pg.QueryResultRow>(
    sql: string,
    params: unknown[] = [],
  ): Promise<T[]> {
    if (!this.active)
      throw new CodeMemoryError("READER_CLOSED", "Index reader transaction has ended");
    return (await this.connection.query<T>(sql, [this.scope, ...params])).rows;
  }
  private checkPage(page: PageRequest) {
    if (
      !Number.isInteger(page.limit) ||
      page.limit < 1 ||
      page.limit > 100 ||
      !Number.isInteger(page.offset) ||
      page.offset < 0 ||
      page.offset > 100000
    )
      throw new CodeMemoryError("INVALID_PAGE", "Limit must be 1–100 and offset 0–100000");
  }
  private async resolve(selector: SymbolSelector): Promise<CodeSymbol> {
    const rows = await this.query<{ data: CodeSymbol }>(
      `SELECT data FROM symbols WHERE repository_id=$1 AND ${selector.symbolId ? "id=$2" : "(name=$2 OR qualified_name=$2) AND data->>'kind' NOT IN ('IMPORT','EXPORT')"}
       ORDER BY data->>'file' COLLATE "C", (data->>'startLine')::int, id COLLATE "C" LIMIT 21`,
      [selector.symbolId || selector.name || null],
    );
    if (!rows[0]) throw new CodeMemoryError("NOT_FOUND", "Symbol not found in selected project");
    if (rows.length > 1)
      throw new CodeMemoryError(
        "AMBIGUOUS_SYMBOL",
        JSON.stringify(
          rows
            .slice(0, 20)
            .map(({ data: s }) => ({ id: s.id, file: s.file, name: s.qualifiedName })),
        ),
      );
    return rows[0].data;
  }
  async searchSymbols(query: string, kinds: string[], page: PageRequest) {
    this.checkPage(page);
    const q = query.toLowerCase(),
      pattern = literalPattern(q);
    const rows = await this.query<{ data: CodeSymbol; score: number; reason: string }>(
      `
      WITH candidates AS (
        SELECT s.*, f.data->>'generated'='true' AS generated,
          CASE WHEN lower(s.name)=$2 THEN 100 WHEN lower(s.qualified_name)=$2 THEN 95
               WHEN lower(s.name) LIKE $3 THEN 80 WHEN lower(s.name) LIKE $4 THEN 65
               ELSE 50*similarity(lower(s.name),$2) END AS base_score,
          CASE WHEN lower(s.name)=$2 THEN 'exact name' WHEN lower(s.qualified_name)=$2 THEN 'qualified name'
               WHEN lower(s.name) LIKE $3 THEN 'prefix' WHEN lower(s.name) LIKE $4 THEN 'substring'
               ELSE 'trigram' END AS base_reason
        FROM symbols s JOIN files f ON f.repository_id=s.repository_id AND f.id=s.file_id
        WHERE s.repository_id=$1 AND (cardinality($5::text[])=0 OR s.data->>'kind'=ANY($5))
          AND (lower(s.name) LIKE $4 OR lower(s.qualified_name)=$2 OR lower(s.name) % $2)
      ) SELECT data,
        base_score * CASE WHEN data->>'kind' IN ('IMPORT','EXPORT') THEN 0.6 ELSE 1 END * CASE WHEN generated THEN 0.5 ELSE 1 END AS score,
        base_reason || CASE WHEN data->>'kind' IN ('IMPORT','EXPORT') THEN '; alias declaration' ELSE '' END || CASE WHEN generated THEN '; generated penalty' ELSE '' END AS reason
      FROM candidates ORDER BY score DESC, data->>'file' COLLATE "C", (data->>'startLine')::int, id COLLATE "C"
      LIMIT $6 OFFSET $7`,
      [q, `${pattern}%`, `%${pattern}%`, kinds, page.limit + 1, page.offset],
    );
    return pageResult(
      rows.map(({ data, score, reason }) => ({ ...data, score: Number(score), reason })),
      page,
    );
  }
  async searchCode(query: string, page: PageRequest) {
    this.checkPage(page);
    const pattern = `%${literalPattern(query.toLowerCase())}%`;
    const rows = await this.query(
      `
      SELECT f.path AS file, l.ordinality::int AS line, left(l.text,500) AS snippet,
             CASE WHEN f.data->>'generated'='true' THEN 0.5 ELSE 1 END::float8 AS score, 'lexical substring' AS reason
      FROM files f CROSS JOIN LATERAL regexp_split_to_table(f.data->>'content', E'\\r?\\n') WITH ORDINALITY AS l(text,ordinality)
      WHERE f.repository_id=$1 AND f.data->>'status'='INDEXED'
        AND lower(f.data->>'content') LIKE $2 AND lower(l.text) LIKE $2
      ORDER BY f.path COLLATE "C", l.ordinality LIMIT $3 OFFSET $4`,
      [pattern, page.limit + 1, page.offset],
    );
    return pageResult(rows, page);
  }
  async symbol(selector: SymbolSelector) {
    const symbol = await this.resolve(selector);
    const rows = await this.query(
      `
      SELECT left(array_to_string((regexp_split_to_array(data->>'content', E'\\r?\\n'))[$3:$4], E'\\n'),4000) AS snippet,
        (SELECT count(*)::int FROM symbol_edges WHERE repository_id=$1 AND target_id=$5) AS incoming,
        (SELECT count(*)::int FROM symbol_edges WHERE repository_id=$1 AND source_id=$5) AS outgoing
      FROM files WHERE repository_id=$1 AND id=$2`,
      [symbol.fileId, symbol.startLine, Math.min(symbol.endLine, symbol.startLine + 15), symbol.id],
    );
    return { symbol, ...rows[0] };
  }
  async relationships(
    selector: SymbolSelector,
    direction: "incoming" | "outgoing",
    type: string,
    page: PageRequest,
  ) {
    this.checkPage(page);
    const symbol = await this.resolve(selector);
    const anchor = direction === "incoming" ? "target_id" : "source_id";
    const neighbor = direction === "incoming" ? "source_id" : "target_id";
    const rows = await this.query<{ data: Record<string, unknown>; symbol: CodeSymbol }>(
      `
      SELECT e.data, s.data AS symbol FROM symbol_edges e
      JOIN symbols s ON s.repository_id=e.repository_id AND s.id=e.${neighbor}
      WHERE e.repository_id=$1 AND e.${anchor}=$2 AND e.edge_type=$3
      ORDER BY s.data->>'file' COLLATE "C", (e.data->>'line')::int, e.id COLLATE "C" LIMIT $4 OFFSET $5`,
      [symbol.id, type, page.limit + 1, page.offset],
    );
    return pageResult(
      rows.map(({ data, symbol }) => ({ ...data, symbol })),
      page,
    );
  }
  async outline(path: string, page: PageRequest) {
    this.checkPage(page);
    const file = await this.query<{ id: string }>(
      "SELECT id FROM files WHERE repository_id=$1 AND path=$2 AND data->>'status'='INDEXED'",
      [path],
    );
    if (!file[0]) throw new CodeMemoryError("NOT_FOUND", "File not present in selected index");
    const rows = await this.query<{ data: CodeSymbol }>(
      `SELECT data FROM symbols WHERE repository_id=$1 AND file_id=$2 ORDER BY (data->>'startLine')::int, (data->>'startColumn')::int, id COLLATE "C" LIMIT $3 OFFSET $4`,
      [file[0].id, page.limit + 1, page.offset],
    );
    return pageResult(
      rows.map((r) => r.data),
      page,
    );
  }
  async context(path: string, line: number, before: number, after: number) {
    if (
      !Number.isSafeInteger(line) ||
      line < 1 ||
      line > 2147483597 ||
      !Number.isInteger(before) ||
      before < 0 ||
      before > 50 ||
      !Number.isInteger(after) ||
      after < 0 ||
      after > 50
    )
      throw new CodeMemoryError("INVALID_RANGE", "Invalid bounded file context range");
    const start = Math.max(1, line - before);
    const rows = await this.query<{ content: string; endLine: number; total: number }>(
      `
      WITH selected AS (SELECT regexp_split_to_array(data->>'content', E'\\r?\\n') AS lines FROM files WHERE repository_id=$1 AND path=$2 AND data->>'status'='INDEXED')
      SELECT left(array_to_string(lines[$3:$4],E'\\n'),12000) AS content, least(cardinality(lines),$4) AS "endLine", cardinality(lines) AS total FROM selected`,
      [path, start, line + after],
    );
    if (!rows[0]) throw new CodeMemoryError("NOT_FOUND", "File not present in selected index");
    if (line > rows[0].total)
      throw new CodeMemoryError("INVALID_RANGE", "Line is beyond indexed file content");
    return {
      path,
      startLine: start,
      endLine: rows[0].endLine,
      content: rows[0].content,
      source: "indexed snapshot",
    };
  }
  async trace(
    from: string,
    direction: "incoming" | "outgoing",
    maxDepth: number,
    maxPaths: number,
    types: string[],
  ) {
    if (
      !Number.isInteger(maxDepth) ||
      maxDepth < 1 ||
      maxDepth > 10 ||
      !Number.isInteger(maxPaths) ||
      maxPaths < 1 ||
      maxPaths > 100
    )
      throw new CodeMemoryError("INVALID_RANGE", "Invalid traversal bounds");
    await this.resolve({ symbolId: from });
    const anchor = direction === "incoming" ? "target_id" : "source_id";
    const neighbor = direction === "incoming" ? "source_id" : "target_id";
    const paths: string[][] = [],
      queue: string[][] = [[from]],
      adjacency = new Map<string, string[]>();
    let truncated = false,
      steps = 0,
      fetched = 0;
    const deadline = Date.now() + 5000;
    while (queue.length && paths.length < maxPaths && steps++ < 10000) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      const path = queue.shift() as string[],
        last = path[path.length - 1] as string;
      if (path.length > maxDepth) {
        paths.push(path);
        continue;
      }
      let next = adjacency.get(last);
      if (!next) {
        if (adjacency.size >= 128 || fetched >= 10000) {
          truncated = true;
          break;
        }
        const limit = Math.min(1000, 10000 - fetched);
        const rows = await this.query<{ id: string }>(
          `SELECT DISTINCT ${neighbor} COLLATE "C" AS id FROM symbol_edges WHERE repository_id=$1 AND ${anchor}=$2 AND (cardinality($3::text[])=0 OR edge_type=ANY($3)) ORDER BY id LIMIT $4`,
          [last, types, limit + 1],
        );
        if (rows.length > limit) truncated = true;
        next = rows.slice(0, limit).map((r) => r.id);
        fetched += next.length;
        adjacency.set(last, next);
      }
      const available = next.filter((n) => !path.includes(n));
      if (!available.length) {
        paths.push(path);
        continue;
      }
      for (const id of available) {
        if (queue.length >= 1000) {
          truncated = true;
          break;
        }
        queue.push([...path, id]);
      }
    }
    return { paths, truncated: truncated || queue.length > 0 };
  }
}

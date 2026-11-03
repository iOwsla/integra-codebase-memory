import {
  CodeMemoryError,
  type CodeSymbol,
  type IndexReader,
  type PageRequest,
  type SymbolSelector,
} from "@codememory/core";
import type pg from "pg";

const literalPattern = (text: string) => text.replace(/[\\%_]/g, "\\$&");
type SearchCodeRow = {
  file: string;
  line: number;
  snippet: string;
  score: number;
  reason: string;
};
type SearchCodeBatch = {
  files: number;
  last: string | null;
  hits: number;
  pageRows: SearchCodeRow[];
};
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
      WITH candidates AS MATERIALIZED (
        SELECT s.*,
          CASE WHEN lower(s.name)=$2 THEN 100 WHEN lower(s.qualified_name)=$2 THEN 95
               WHEN lower(s.name) LIKE $3 THEN 80 WHEN lower(s.name) LIKE $4 THEN 65
               ELSE 50*similarity(lower(s.name),$2) END AS base_score,
          CASE WHEN lower(s.name)=$2 THEN 'exact name' WHEN lower(s.qualified_name)=$2 THEN 'qualified name'
               WHEN lower(s.name) LIKE $3 THEN 'prefix' WHEN lower(s.name) LIKE $4 THEN 'substring'
               ELSE 'trigram' END AS base_reason
        FROM symbols s
        WHERE s.repository_id=$1 AND (cardinality($5::text[])=0 OR s.data->>'kind'=ANY($5))
          AND (lower(s.name) LIKE $4 OR lower(s.qualified_name)=$2 OR lower(s.name) % $2)
      ), file_flags AS MATERIALIZED (
        -- files.data embeds the whole source; read the flag once per candidate file.
        SELECT f.id, f.data->>'generated'='true' AS generated FROM files f
        WHERE f.repository_id=$1 AND f.id IN (SELECT DISTINCT file_id FROM candidates)
      ) SELECT data,
        base_score * CASE WHEN data->>'kind' IN ('IMPORT','EXPORT') THEN 0.6 ELSE 1 END * CASE WHEN generated THEN 0.5 ELSE 1 END AS score,
        base_reason || CASE WHEN data->>'kind' IN ('IMPORT','EXPORT') THEN '; alias declaration' ELSE '' END || CASE WHEN generated THEN '; generated penalty' ELSE '' END AS reason
      FROM candidates c JOIN file_flags g ON g.id=c.file_id
      ORDER BY score DESC,
        CASE WHEN data->>'file' ~ '(^|/)(__tests__|tests?|spec)/|\\.(test|spec)\\.' THEN 1 ELSE 0 END,
        CASE WHEN data->>'kind' IN ('CLASS','INTERFACE') THEN 0 WHEN data->>'kind' IN ('FUNCTION','METHOD') THEN 1 ELSE 2 END,
        data->>'file' COLLATE "C", (data->>'startLine')::int, c.id COLLATE "C"
      LIMIT $6 OFFSET $7`,
      [q, `${pattern}%`, `%${pattern}%`, kinds, page.limit + 1, page.offset],
    );
    return pageResult(
      rows.map(({ data, score, reason }) => ({ ...data, score: Number(score), reason })),
      page,
    );
  }
  /** Streams matching files in path order and stops once the page is covered, instead
   * of splitting every matching file before the final sort. Each batch reports how many
   * matching lines it held, so only the requested window is returned from SQL. Every
   * matching file holds at least one matching line, so the first batch is sized to cover
   * the page; later batches grow quickly because each one filters the remaining files. */
  async searchCode(query: string, page: PageRequest) {
    this.checkPage(page);
    const pattern = `%${literalPattern(query.toLowerCase())}%`;
    const wanted = page.limit + 1,
      deadline = Date.now() + 4000,
      rows: SearchCodeRow[] = [];
    let seen = 0,
      cursor: string | null = null,
      batch = Math.min(4096, Math.max(64, page.offset + wanted));
    while (rows.length < wanted) {
      if (Date.now() > deadline)
        throw new CodeMemoryError(
          "QUERY_TIMEOUT",
          "Scoped index query exceeded its execution budget; narrow the query",
        );
      const skip = Math.max(0, page.offset - seen);
      const [result]: SearchCodeBatch[] = await this.query<SearchCodeBatch>(
        `
        WITH batch AS MATERIALIZED (
          SELECT path, data->>'content' AS content,
            CASE WHEN data->>'generated'='true' THEN 0.5 ELSE 1 END::float8 AS score
          FROM files WHERE repository_id=$1 AND data->>'status'='INDEXED'
            AND lower(data->>'content') LIKE $2 AND ($3::text IS NULL OR path COLLATE "C" > $3)
          ORDER BY path COLLATE "C" LIMIT $4
        ), hits AS MATERIALIZED (
          SELECT b.path, l.ordinality::int AS line, left(l.text,500) AS snippet, b.score
          FROM batch b CROSS JOIN LATERAL regexp_split_to_table(b.content, E'\\r?\\n') WITH ORDINALITY AS l(text,ordinality)
          WHERE lower(l.text) LIKE $2
        )
        SELECT (SELECT count(*)::int FROM batch) AS files,
          (SELECT max(path COLLATE "C") FROM batch) AS last,
          (SELECT count(*)::int FROM hits) AS hits,
          (SELECT coalesce(jsonb_agg(jsonb_build_object('file',path,'line',line,'snippet',snippet,'score',score,'reason','lexical substring')
             ORDER BY path COLLATE "C", line),'[]') FROM (SELECT * FROM hits ORDER BY path COLLATE "C", line OFFSET $5 LIMIT $6) w) AS "pageRows"`,
        [pattern, cursor, batch, skip, wanted - rows.length],
      );
      if (!result) break;
      rows.push(...result.pageRows);
      seen += result.hits;
      if (result.files < batch || result.last === null) break;
      cursor = result.last;
      batch = Math.min(batch * 4, 4096);
    }
    return pageResult(rows, page);
  }
  async symbol(selector: SymbolSelector) {
    const symbol = await this.resolve(selector);
    const rows = await this.query(
      `
      SELECT left(array_to_string((regexp_split_to_array(data->>'content', E'\\r?\\n'))[$3:$4], E'\\n'),4000) AS snippet,
        length(array_to_string((regexp_split_to_array(data->>'content', E'\\r?\\n'))[$3:$4], E'\\n'))>4000 AS "characterTruncated",
        (SELECT count(*)::int FROM symbol_edges WHERE repository_id=$1 AND target_id=$5) AS incoming,
        (SELECT count(*)::int FROM symbol_edges WHERE repository_id=$1 AND source_id=$5) AS outgoing,
        (SELECT coalesce(jsonb_object_agg(edge_type,n),'{}') FROM (SELECT edge_type, count(*)::int AS n
          FROM symbol_edges WHERE repository_id=$1 AND target_id=$5 GROUP BY edge_type) t) AS "incomingByType",
        (SELECT coalesce(jsonb_object_agg(edge_type,n),'{}') FROM (SELECT edge_type, count(*)::int AS n
          FROM symbol_edges WHERE repository_id=$1 AND source_id=$5 GROUP BY edge_type) t) AS "outgoingByType",
        (SELECT count(*)::int FROM symbol_edges WHERE repository_id=$1 AND target_id=$5
          AND source_id<>$5 AND edge_type NOT IN ('DECLARES','EXPORTS')) AS "usageIncoming"
      FROM files WHERE repository_id=$1 AND id=$2`,
      [symbol.fileId, symbol.startLine, Math.min(symbol.endLine, symbol.startLine + 15), symbol.id],
    );
    const row = rows[0];
    const snippet = String(row?.snippet ?? "");
    const returnedStartLine = symbol.startLine;
    const returnedEndLine = returnedStartLine + snippet.split("\n").length - 1;
    const snippetTruncated = !!row?.characterTruncated || returnedEndLine < symbol.endLine;
    return {
      symbol,
      ...row,
      snippetTruncated,
      returnedStartLine,
      returnedEndLine,
      returnedEndLinePartial: !!row?.characterTruncated,
      continuation: snippetTruncated
        ? {
            tool: "get_file_context",
            arguments: {
              path: symbol.file,
              line: row?.characterTruncated ? returnedEndLine : returnedEndLine + 1,
              before: 0,
              after: 50,
            },
            note: "Continue through the symbol endLine. A partial line is repeated; if context also truncates that line, read the local source.",
          }
        : null,
    };
  }
  async relationships(
    selector: SymbolSelector,
    direction: "incoming" | "outgoing",
    type: string,
    page: PageRequest,
  ) {
    this.checkPage(page);
    const symbol = await this.resolve(selector);
    if (direction === "incoming" && type === "CALLS") return this.callers(symbol, page);
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
  /** Direct callers plus calls made through an interface or base-class member the
   * symbol implements or overrides. Those rows carry `dispatch.via`: the receiver's
   * static type names the supertype member, so the runtime target may be another
   * implementation. Only instance members dispatch: constructors and static members
   * keep their direct callers alone, and `super.member()` calls (edge metadata
   * receiver "super") always run the base implementation. Members match by name on a
   * declared IMPLEMENTS/EXTENDS ancestor. Rows expose the edge's recorded receiver
   * static type as `dispatch.receiverType`. A class receiver that is not one of those
   * ancestors is dropped. This is a nominal heuristic: TypeScript checks
   * assignability structurally, so an instance can also be held by a sibling class
   * that declares no extra members, and such callers are omitted. Interface
   * receivers, and receivers whose symbol is no longer indexed, are always kept. */
  private async callers(symbol: CodeSymbol, page: PageRequest) {
    const rows = await this.query<{
      data: Record<string, unknown>;
      symbol: CodeSymbol;
      via: Record<string, unknown> | null;
    }>(
      `
      WITH RECURSIVE anchor AS (
        SELECT id, name FROM symbols
        WHERE repository_id=$1 AND id=$2 AND data->>'kind'<>'CONSTRUCTOR'
          AND coalesce(data->>'static','false')='false'
      ), supers(id, depth) AS (
        SELECT h.target_id, 1 FROM symbol_edges d
        JOIN symbol_edges h ON h.repository_id=d.repository_id AND h.source_id=d.source_id
          AND h.edge_type IN ('IMPLEMENTS','EXTENDS')
        WHERE d.repository_id=$1 AND d.target_id=$2 AND d.edge_type='DECLARES'
        UNION
        SELECT h.target_id, s.depth+1 FROM supers s
        JOIN symbol_edges h ON h.repository_id=$1 AND h.source_id=s.id
          AND h.edge_type IN ('IMPLEMENTS','EXTENDS')
        WHERE s.depth < 10
      ), targets AS (
        SELECT $2::text AS id, NULL::jsonb AS via
        UNION
        SELECT m.id, jsonb_build_object('id',m.id,'qualifiedName',m.qualified_name,
          'kind',m.data->>'kind','file',m.data->>'file','startLine',m.data->'startLine')
        FROM (SELECT DISTINCT id FROM supers) s
        JOIN symbol_edges d ON d.repository_id=$1 AND d.source_id=s.id AND d.edge_type='DECLARES'
        JOIN symbols m ON m.repository_id=$1 AND m.id=d.target_id
        JOIN anchor a ON m.name=a.name AND m.id<>a.id
        WHERE coalesce(m.data->>'static','false')='false' AND m.data->>'kind'<>'CONSTRUCTOR'
      )
      SELECT e.data, s.data AS symbol, t.via FROM targets t
      JOIN symbol_edges e ON e.repository_id=$1 AND e.target_id=t.id AND e.edge_type='CALLS'
      JOIN symbols s ON s.repository_id=e.repository_id AND s.id=e.source_id
      WHERE t.via IS NULL OR (
        e.data#>>'{metadata,receiver}' IS DISTINCT FROM 'super'
        AND (e.data#>>'{metadata,receiverType}' IS NULL
          OR e.data#>>'{metadata,receiverType}' IN (SELECT id FROM supers)
          OR NOT EXISTS (SELECT 1 FROM symbols r WHERE r.repository_id=$1
            AND r.id=e.data#>>'{metadata,receiverType}' AND r.data->>'kind'='CLASS')))
      ORDER BY s.data->>'file' COLLATE "C", (e.data->>'line')::int, e.id COLLATE "C" LIMIT $3 OFFSET $4`,
      [symbol.id, page.limit + 1, page.offset],
    );
    return pageResult(
      rows.map(({ data, symbol, via }) => ({
        ...data,
        symbol,
        ...(via
          ? {
              dispatch: {
                via,
                receiverType:
                  (data.metadata as { receiverType?: string } | undefined)?.receiverType ?? null,
              },
            }
          : {}),
      })),
      page,
    );
  }
  private async qualityMetadata() {
    // Publish records the total with each run; count rows only for older runs without it.
    const [row] = await this.query<{ count: string }>(
      `SELECT COALESCE(
        (SELECT (data->'totals'->>'unresolvedReferences')::bigint FROM index_runs WHERE repository_id=$1 ORDER BY id DESC LIMIT 1),
        (SELECT count(*) FROM unresolved_references WHERE repository_id=$1))::text AS count`,
    );
    return {
      candidateOnly: true,
      fingerprintRequirement:
        "Reindex with parser revision 5 or newer before interpreting results. Empty results never certify absence.",
      unresolvedReferences: Number(row?.count ?? 0),
      limitations:
        "Static indexed sources only. Check exports, entry points, callbacks, dynamic uses and excluded consumers. A candidate is not permission to delete or merge code.",
    };
  }
  async deadCodeCandidates(page: PageRequest) {
    this.checkPage(page);
    const rows = await this.query<{ symbol: Record<string, unknown> }>(
      `
      SELECT jsonb_build_object('id',s.id,'name',s.name,'file',s.data->>'file',
        'startLine',s.data->'startLine','endLine',s.data->'endLine','kind',s.data->>'kind') AS symbol
      FROM symbols s JOIN files f ON f.repository_id=s.repository_id AND f.id=s.file_id
      WHERE s.repository_id=$1 AND s.data->>'kind'='FUNCTION'
        AND s.data->>'exported'='false' AND s.name NOT LIKE '<%'
        AND s.data->'metadata'->>'bodyHash' IS NOT NULL
        AND f.data->>'status'='INDEXED' AND f.data->>'generated'='false'
        AND NOT EXISTS (SELECT 1 FROM symbol_edges e WHERE e.repository_id=s.repository_id
          AND e.target_id=s.id AND e.source_id<>s.id AND e.edge_type<>'DECLARES')
      ORDER BY s.data->>'file' COLLATE "C", (s.data->>'startLine')::int, s.id COLLATE "C"
      LIMIT $2 OFFSET $3`,
      [page.limit + 1, page.offset],
    );
    return {
      ...(await this.qualityMetadata()),
      ...pageResult(
        rows.map(({ symbol }) => ({
          symbol,
          reason: "NO_RECORDED_INCOMING_USAGE",
          requiredChecks: [
            "entry points",
            "exports and external consumers",
            "callbacks and dynamic registration",
            "excluded sources",
          ],
        })),
        page,
      ),
      scope:
        "Named, non-exported implemented FUNCTION symbols in non-generated indexed files. Methods and anonymous callbacks excluded. Self-usage ignored; unreachable cycles are not detected.",
    };
  }
  async duplicateCode(minBodyLength: number, page: PageRequest) {
    this.checkPage(page);
    if (!Number.isInteger(minBodyLength) || minBodyLength < 20 || minBodyLength > 100000)
      throw new CodeMemoryError("INVALID_INPUT", "Body length must be 20..100000");
    const rows = await this.query<{
      symbol: Record<string, unknown>;
      bodyHash: string;
      groupSize: number;
    }>(
      `
      WITH candidates AS (
        SELECT s.*, count(*) OVER (PARTITION BY s.data->'metadata'->>'bodyHash') AS copies
        FROM symbols s JOIN files f ON f.repository_id=s.repository_id AND f.id=s.file_id
        WHERE s.repository_id=$1 AND s.data->'metadata'->>'bodyHash' IS NOT NULL
          AND (s.data->'metadata'->>'bodyLength')::int >= $2
          AND f.data->>'status'='INDEXED' AND f.data->>'generated'='false'
      ) SELECT jsonb_build_object('id',id,'name',name,'file',data->>'file',
          'startLine',data->'startLine','endLine',data->'endLine','kind',data->>'kind',
          'bodyStartLine',data->'metadata'->'bodyStartLine','bodyEndLine',data->'metadata'->'bodyEndLine') AS symbol,
        data->'metadata'->>'bodyHash' AS "bodyHash", copies::int AS "groupSize"
      FROM candidates WHERE copies>1
      ORDER BY data->'metadata'->>'bodyHash' COLLATE "C", data->>'file' COLLATE "C",
        (data->>'startLine')::int, id COLLATE "C" LIMIT $3 OFFSET $4`,
      [minBodyLength, page.limit + 1, page.offset],
    );
    return {
      ...(await this.qualityMetadata()),
      ...pageResult(
        rows.map((row) => ({
          ...row,
          reason: "IDENTICAL_BODY_TEXT",
          requiredChecks: [
            "parameters and captured values",
            "side effects and business rules",
            "callers before extraction",
          ],
        })),
        page,
      ),
      minBodyLength,
      scope:
        "Exact implemented body text with normalized line endings. Names/signatures are outside the fingerprint; comments, other whitespace, identifiers and literals remain significant. Rows paginate across group members; a group may span pages. Not semantic clone detection.",
    };
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
    const rows = await this.query<{
      content: string;
      endLine: number;
      total: number;
      characterTruncated: boolean;
    }>(
      `
      WITH selected AS (SELECT regexp_split_to_array(data->>'content', E'\\r?\\n') AS lines FROM files WHERE repository_id=$1 AND path=$2 AND data->>'status'='INDEXED')
      SELECT left(array_to_string(lines[$3:$4],E'\\n'),12000) AS content, length(array_to_string(lines[$3:$4],E'\\n'))>12000 AS "characterTruncated", least(cardinality(lines),$4) AS "endLine", cardinality(lines) AS total FROM selected`,
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
      snippetTruncated: rows[0].characterTruncated,
      returnedStartLine: start,
      returnedEndLine: start + rows[0].content.split("\n").length - 1,
      returnedEndLinePartial: rows[0].characterTruncated,
      continuation: rows[0].characterTruncated
        ? {
            note: "Character limit reached. Read the local source if this line exceeds the context limit.",
            path,
            line: start + rows[0].content.split("\n").length - 1,
          }
        : rows[0].endLine < rows[0].total
          ? {
              tool: "get_file_context",
              arguments: { path, line: rows[0].endLine + 1, before: 0, after: 50 },
            }
          : null,
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
      adjacency = new Map<string, string[]>(),
      prefetched = new Map<string, string[]>();
    let truncated = false,
      steps = 0,
      fetched = 0,
      head = 0;
    const deadline = Date.now() + 5000;
    // Neighbours of every uncached node still queued (the rest of the current BFS
    // level) load in one statement. Each list holds one row more than the largest
    // limit it can be committed with, so committing on dequeue below applies the
    // node, fetched and per-source caps exactly as one query per node would. A batch
    // takes only as many sources as the remaining fetched budget can fill at the
    // per-source limit, so one statement does no more work than the per-node loop
    // would before stopping.
    const prefetch = async (start: number) => {
      const sources: string[] = [];
      const perSource = Math.min(1000, 10000 - fetched) + 1;
      const room = Math.min(
        128 - adjacency.size,
        Math.max(1, Math.floor((10000 - fetched) / (perSource - 1))),
      );
      for (let i = start; i < queue.length && sources.length < room; i++) {
        const path = queue[i] as string[],
          id = path[path.length - 1] as string;
        if (path.length > maxDepth || adjacency.has(id) || prefetched.has(id)) continue;
        if (!sources.includes(id)) sources.push(id);
      }
      const rows = await this.query<{ src: string; id: string }>(
        `SELECT a.src, n.id FROM unnest($2::text[]) WITH ORDINALITY AS a(src, ord)
         CROSS JOIN LATERAL (SELECT DISTINCT ${neighbor} COLLATE "C" AS id FROM symbol_edges
           WHERE repository_id=$1 AND ${anchor}=a.src AND (cardinality($3::text[])=0 OR edge_type=ANY($3))
           ORDER BY id LIMIT $4) n
         ORDER BY a.ord, n.id`,
        [sources, types, perSource],
      );
      for (const id of sources) prefetched.set(id, []);
      for (const row of rows) prefetched.get(row.src)?.push(row.id);
    };
    while (head < queue.length && paths.length < maxPaths && steps++ < 10000) {
      if (Date.now() > deadline) {
        truncated = true;
        break;
      }
      const path = queue[head++] as string[],
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
        if (!prefetched.has(last)) await prefetch(head - 1);
        const limit = Math.min(1000, 10000 - fetched);
        const rows = prefetched.get(last) ?? [];
        prefetched.delete(last);
        if (rows.length > limit) truncated = true;
        next = rows.slice(0, limit);
        fetched += next.length;
        adjacency.set(last, next);
      }
      const available = next.filter((n) => !path.includes(n));
      if (!available.length) {
        paths.push(path);
        continue;
      }
      for (const id of available) {
        if (queue.length - head >= 1000) {
          truncated = true;
          break;
        }
        queue.push([...path, id]);
      }
    }
    return { paths, truncated: truncated || head < queue.length };
  }
}

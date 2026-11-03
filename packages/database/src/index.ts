import { createHash } from "node:crypto";
import type {
  IndexMetadata,
  IndexProgress,
  IndexReader,
  IndexResult,
  IndexState,
  MemoryEntry,
  MemorySearch,
  ProjectContext,
  ProjectStore,
  Snapshot,
  StatusOptions,
} from "@codememory/core";
import { CodeMemoryError } from "@codememory/core";
import { log, projectName, runtimeInfo } from "@codememory/shared";
import pg from "pg";
import { PostgresHistory } from "./history";
import { MemoryWorkflowRepository } from "./memory-workflow";
import { PostgresIndexReader } from "./reader";
import { migrations } from "./schema";
export const defaultDatabaseUrl =
  "postgresql://codememory:local-development-only@127.0.0.1:55432/codememory";
// True while the backend recorded in index_jobs still holds the project's session advisory
// lock (pg_try_advisory_lock(bigint) splits the key into classid/objid with objsubid=1).
const indexLockActive = (pid: string, scope: string) =>
  `EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=${pid} AND l.locktype='advisory' AND l.granted
        AND l.classid::bigint=((hashtextextended(${scope},0)>>32)&4294967295)
        AND l.objid::bigint=(hashtextextended(${scope},0)&4294967295) AND l.objsubid=1)`;
const keptIndexRuns = 20;
export class PostgresStore extends MemoryWorkflowRepository implements ProjectStore {
  constructor(
    url = process.env.DATABASE_URL ?? defaultDatabaseUrl,
    private readonly connection?: pg.PoolClient,
    pool?: pg.Pool,
  ) {
    super(
      pool ??
        new pg.Pool({
          connectionString: url,
          max: 6,
          connectionTimeoutMillis: 5000,
          statement_timeout: 30000,
        }),
    );
    if (!pool) {
      this.pool.on("error", () => log("error", "database_idle_connection_lost"));
      // pg-pool drops its own listener while a client is checked out; without one, a backend
      // terminated mid-query emits an unhandled 'error' event and exits the process.
      this.pool.on("connect", (client) =>
        client.on("error", () => log("error", "database_connection_lost")),
      );
    }
  }
  history(context: ProjectContext) {
    return new PostgresHistory(this.pool, context.projectScopeId);
  }
  private query(text: string, values: unknown[] = []) {
    return (this.connection ?? this.pool).query(text, values);
  }
  /**
   * Runs on the injected connection (never listened to or released here) unless `pooled`, else on
   * a pooled client that is released as broken after a connection error.
   */
  private async withClient<T>(
    action: (conn: pg.PoolClient, broken: () => boolean) => Promise<T>,
    pooled = false,
  ): Promise<T> {
    if (this.connection && !pooled) return action(this.connection, () => false);
    const conn = await this.pool.connect();
    let connectionError: Error | undefined;
    const onError = (error: Error) => {
      connectionError = error;
    };
    conn.on("error", onError);
    try {
      return await action(conn, () => !!connectionError);
    } finally {
      conn.removeListener("error", onError);
      conn.release(connectionError);
    }
  }
  // `through` lets tests rebuild an older installation's schema before upgrading it.
  async migrate(through = migrations.length) {
    if (!Number.isInteger(through) || through < 1 || through > migrations.length)
      throw new CodeMemoryError("INVALID_ARGUMENT", "Unknown migration version");
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('codememory:migrations',0))");
      await c.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const [index, sql] of migrations.slice(0, through).entries()) {
        const version = index + 1;
        const r = await c.query("SELECT version FROM schema_migrations WHERE version=$1", [
          version,
        ]);
        if (!r.rowCount) {
          await c.query(sql);
          await c.query("INSERT INTO schema_migrations(version) VALUES($1)", [version]);
        }
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async register(c: ProjectContext) {
    await this.query(
      "INSERT INTO repositories(id,root,name) VALUES($1,$2,$3) ON CONFLICT(id) DO NOTHING",
      [c.projectScopeId, c.canonicalRoot, projectName(c)],
    );
  }
  async locked<T>(c: ProjectContext, action: (store: ProjectStore) => Promise<T>): Promise<T> {
    const conn = await this.pool.connect();
    let connectionError: Error | undefined;
    let acquired = false;
    const onError = (error: Error) => {
      connectionError = error;
    };
    conn.on("error", onError);
    try {
      const lock = await conn.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [c.projectScopeId],
      );
      acquired = lock.rows[0]?.acquired === true;
      if (!acquired)
        throw new CodeMemoryError(
          "INDEX_BUSY",
          "Selected project is being indexed by another process; inspect status.lastIndexJob.owner and lockActive, then wait or reconnect the outdated client",
        );
      return await action(new PostgresStore(undefined, conn, this.pool));
    } finally {
      try {
        if (acquired && !connectionError)
          await conn.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [c.projectScopeId]);
      } finally {
        conn.removeListener("error", onError);
        conn.release(connectionError);
      }
    }
  }
  async snapshot(c: ProjectContext): Promise<Snapshot> {
    return this.withClient(async (conn, broken) => {
      try {
        await conn.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const repo = (
          await conn.query(
            "SELECT version,fingerprint,indexed_at,(SELECT data->'diagnostics' FROM index_runs WHERE repository_id=$1 ORDER BY id DESC LIMIT 1) AS diagnostics FROM repositories WHERE id=$1",
            [c.projectScopeId],
          )
        ).rows[0];
        const arrays: Record<string, unknown[]> = {};
        for (const table of ["files", "symbols", "symbol_edges", "unresolved_references"])
          arrays[table] = (
            await conn.query(`SELECT data FROM ${table} WHERE repository_id=$1`, [c.projectScopeId])
          ).rows.map((r) => r.data);
        await conn.query("COMMIT");
        return {
          files: arrays.files,
          symbols: arrays.symbols,
          edges: arrays.symbol_edges,
          unresolved: arrays.unresolved_references,
          diagnostics: repo?.diagnostics ?? [],
          version: repo?.version ?? 0,
          fingerprint: repo?.fingerprint ?? "",
          indexedAt: repo?.indexed_at?.toISOString() ?? null,
        } as Snapshot;
      } catch (e) {
        if (!broken()) await conn.query("ROLLBACK");
        throw e;
      }
    });
  }
  /** Bounded sample for `debug unresolved`; the total comes from the latest run's totals. */
  async unresolvedSample(c: ProjectContext, limit = 100) {
    const [rows, total] = await Promise.all([
      this.query(
        "SELECT data FROM unresolved_references WHERE repository_id=$1 ORDER BY id LIMIT $2",
        [c.projectScopeId, limit],
      ),
      this.query(
        "SELECT (data->'totals'->>'unresolvedReferences')::int AS total FROM index_runs WHERE repository_id=$1 ORDER BY id DESC LIMIT 1",
        [c.projectScopeId],
      ),
    ]);
    return {
      total: (total.rows[0]?.total as number | null | undefined) ?? null,
      results: rows.rows.map((r) => r.data),
    };
  }
  async indexState(c: ProjectContext): Promise<IndexState> {
    return this.withClient(async (conn, broken) => {
      try {
        await conn.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        const repo = (
          await conn.query(
            "SELECT version,version_floor,fingerprint,indexed_at FROM repositories WHERE id=$1",
            [c.projectScopeId],
          )
        ).rows[0];
        // Generated columns: reading jsonb fields would detoast every file's stored content.
        const files = (
          await conn.query<IndexState["files"][number]>(
            "SELECT path,hash,file_status AS status FROM files WHERE repository_id=$1",
            [c.projectScopeId],
          )
        ).rows;
        await conn.query("COMMIT");
        return {
          files,
          version: repo?.version ?? 0,
          versionFloor: repo?.version_floor ?? 0,
          fingerprint: repo?.fingerprint ?? "",
          indexedAt: repo?.indexed_at?.toISOString() ?? null,
        };
      } catch (error) {
        if (!broken()) await conn.query("ROLLBACK");
        throw error;
      }
    });
  }
  async readIndex<T>(
    c: ProjectContext,
    action: (reader: IndexReader, metadata: IndexMetadata) => Promise<T>,
  ): Promise<T> {
    return this.withClient(async (conn, broken) => {
      const reader = new PostgresIndexReader(conn, c.projectScopeId);
      try {
        await conn.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
        await conn.query("SET LOCAL statement_timeout = '5s'");
        await conn.query("SET LOCAL pg_trgm.similarity_threshold = 0.3");
        // A RUNNING job whose owner no longer holds the project lock was interrupted, not updating.
        const repo = (
          await conn.query(
            `
        SELECT version, indexed_at,
          COALESCE((SELECT CASE WHEN j.data->>'state'='RUNNING' THEN ${indexLockActive("j.backend_pid", "$1")} ELSE false END
            FROM index_jobs j WHERE j.repository_id=$1),false) AS stale,
          (SELECT data->>'startedAt' FROM index_jobs WHERE repository_id=$1) AS stale_since,
          (EXISTS(SELECT 1 FROM files WHERE repository_id=$1 AND data->>'status'<>'INDEXED')
           OR COALESCE((SELECT jsonb_array_length(data->'diagnostics')>0 FROM index_runs WHERE repository_id=$1 ORDER BY id DESC LIMIT 1),false)) AS incomplete
        FROM repositories WHERE id=$1`,
            [c.projectScopeId],
          )
        ).rows[0];
        if (!repo?.version)
          throw new CodeMemoryError("INDEX_NOT_READY", "Selected project has no completed index");
        const result = await action(reader, {
          indexVersion: repo.version,
          indexedAt: repo.indexed_at?.toISOString() ?? null,
          freshness: repo.stale ? "UPDATING" : "LAST_COMPLETED",
          incomplete: repo.incomplete || repo.stale,
          ...(repo.stale ? { staleSince: repo.stale_since } : {}),
        });
        await conn.query("COMMIT");
        return result;
      } catch (e) {
        if (!broken()) await conn.query("ROLLBACK");
        if (e && typeof e === "object" && "code" in e && e.code === "57014")
          throw new CodeMemoryError(
            "QUERY_TIMEOUT",
            "Scoped index query exceeded its execution budget; narrow the query",
          );
        throw e;
      } finally {
        reader.close();
      }
    });
  }
  async publish(
    c: ProjectContext,
    s: Snapshot,
    changed: string[],
    deleted: string[],
    run: IndexResult,
  ) {
    if (!this.connection) throw new Error("Publication requires project lock");
    await this.query("BEGIN");
    try {
      const scope = c.projectScopeId;
      const timed = async (phase: string, rows: number, action: () => Promise<unknown>) => {
        const started = performance.now();
        await action();
        if (process.env.CODEMEMORY_PROFILE === "1")
          log("info", "index_publish_phase", {
            phase,
            rows,
            durationMs: Math.round(performance.now() - started),
          });
      };
      const previous = (
        await this.query("SELECT id,path,analysis_hash FROM files WHERE repository_id=$1", [scope])
      ).rows as { id: string; path: string; analysis_hash: string | null }[];
      const previousHashes = new Map(previous.map((file) => [file.id, file.analysis_hash]));
      const digests = new Map(s.files.map((file) => [file.id, createHash("sha256")]));
      const digestRows = (kind: string, rows: { fileId: string }[]) => {
        for (const row of rows) {
          const digest = digests.get(row.fileId);
          if (!digest) throw new Error(`Analysis refers to an unknown file: ${row.fileId}`);
          digest.update(kind).update("\0").update(JSON.stringify(row)).update("\0");
        }
      };
      const analysisRows = s.symbols.length + s.edges.length + s.unresolved.length;
      await timed("digest", analysisRows, async () => {
        digestRows("symbol", s.symbols);
        digestRows("edge", s.edges);
        digestRows("unresolved", s.unresolved);
      });
      const affected = new Set<string>();
      for (const file of s.files) {
        const digest = digests.get(file.id);
        if (!digest) throw new Error(`Missing analysis digest for ${file.id}`);
        file.analysisHash = digest.digest("hex");
        if (previousHashes.get(file.id) !== file.analysisHash) affected.add(file.id);
      }
      const deletedPaths = new Set(deleted);
      const deletedIds = previous
        .filter((file) => deletedPaths.has(file.path))
        .map((file) => file.id);
      const allAffected = [...affected, ...deletedIds];
      const replaceAll = !s.version || affected.size > s.files.length * 0.7;
      await timed("remove_edges", allAffected.length, () =>
        this.query(
          replaceAll
            ? "DELETE FROM symbol_edges WHERE repository_id=$1"
            : "DELETE FROM symbol_edges WHERE repository_id=$1 AND file_id=ANY($2::text[])",
          replaceAll ? [scope] : [scope, allAffected],
        ),
      );
      await timed("remove_unresolved", allAffected.length, () =>
        this.query(
          replaceAll
            ? "DELETE FROM unresolved_references WHERE repository_id=$1"
            : "DELETE FROM unresolved_references WHERE repository_id=$1 AND data->>'fileId'=ANY($2::text[])",
          replaceAll ? [scope] : [scope, allAffected],
        ),
      );
      await this.query("DELETE FROM files WHERE repository_id=$1 AND path=ANY($2::text[])", [
        scope,
        deleted,
      ]);
      const batches = async (rows: unknown[], query: string) => {
        let records: string[] = [];
        let bytes = 2;
        const flush = async () => {
          if (!records.length) return;
          await this.query(query, [scope, `[${records.join(",")}]`]);
          records = [];
          bytes = 2;
        };
        for (const row of rows) {
          const record = JSON.stringify(row);
          const size = Buffer.byteLength(record) + 1;
          if (records.length && (records.length >= 10000 || bytes + size > 4 * 1024 * 1024))
            await flush();
          records.push(record);
          bytes += size;
        }
        await flush();
      };
      const changedPaths = new Set(changed);
      const changedFiles = s.files.filter((f) => changedPaths.has(f.path) || affected.has(f.id));
      await timed("files", changedFiles.length, () =>
        batches(
          changedFiles,
          `INSERT INTO files(repository_id,id,path,data) SELECT $1,j->>'id',j->>'path',j FROM jsonb_array_elements($2::jsonb) j ON CONFLICT(repository_id,id) DO UPDATE SET data=EXCLUDED.data,path=EXCLUDED.path WHERE files.data IS DISTINCT FROM EXCLUDED.data OR files.path IS DISTINCT FROM EXCLUDED.path`,
        ),
      );
      // An unaffected file's analysisHash covers all of its symbol rows, so they are already
      // stored byte-identically. Narrowing by file is sound because symbol ids are derived from
      // the file path: an id can never move from an unaffected file into an affected one.
      const symbols = replaceAll ? s.symbols : s.symbols.filter((x) => affected.has(x.fileId));
      if (s.version > 1)
        await timed("remove_symbols", replaceAll ? s.symbols.length : allAffected.length, () =>
          replaceAll
            ? this.query("DELETE FROM symbols WHERE repository_id=$1 AND NOT(id=ANY($2::text[]))", [
                scope,
                s.symbols.map((x) => x.id),
              ])
            : this.query(
                "DELETE FROM symbols WHERE repository_id=$1 AND file_id=ANY($2::text[]) AND NOT(id=ANY($3::text[]))",
                [scope, allAffected, symbols.map((x) => x.id)],
              ),
        );
      await timed("symbols", symbols.length, () =>
        batches(
          symbols,
          `INSERT INTO symbols(repository_id,id,file_id,name,qualified_name,data) SELECT $1,j->>'id',j->>'fileId',j->>'name',j->>'qualifiedName',j FROM jsonb_array_elements($2::jsonb) j ON CONFLICT(repository_id,id) DO UPDATE SET data=EXCLUDED.data,file_id=EXCLUDED.file_id,name=EXCLUDED.name,qualified_name=EXCLUDED.qualified_name WHERE symbols.data IS DISTINCT FROM EXCLUDED.data`,
        ),
      );
      const edges = replaceAll ? s.edges : s.edges.filter((edge) => affected.has(edge.fileId));
      await timed("edges", edges.length, () =>
        batches(
          edges,
          `INSERT INTO symbol_edges(repository_id,id,source_id,target_id,file_id,edge_type,data) SELECT $1,j->>'id',j->>'source',j->>'target',j->>'fileId',j->>'type',j FROM jsonb_array_elements($2::jsonb) j`,
        ),
      );
      const unresolved = replaceAll
        ? s.unresolved
        : s.unresolved.filter((reference) => affected.has(reference.fileId));
      await timed("unresolved", unresolved.length, () =>
        batches(
          unresolved,
          // Duplicate ids within one analysis must not abort the publish. DO UPDATE would fail
          // on a duplicate inside the same batch, so the first row wins.
          `INSERT INTO unresolved_references(repository_id,id,data) SELECT $1,j->>'id',j FROM jsonb_array_elements($2::jsonb) j ON CONFLICT(repository_id,id) DO NOTHING`,
        ),
      );
      await this.query(
        "UPDATE repositories SET version=$2,fingerprint=$3,indexed_at=$4,updated_at=now() WHERE id=$1",
        [scope, s.version, s.fingerprint, s.indexedAt],
      );
      await this.query("INSERT INTO index_runs(repository_id,data) VALUES($1,$2)", [
        scope,
        JSON.stringify({
          ...run,
          sessionId: c.sessionId,
          diagnostics: s.diagnostics,
          totals: {
            files: s.files.length,
            symbols: s.symbols.length,
            edges: s.edges.length,
            unresolvedReferences: s.unresolved.length,
          },
        }),
      ]);
      // Readers only use the latest run; keep a short history for diagnosis.
      await this.query(
        "DELETE FROM index_runs WHERE repository_id=$1 AND id<(SELECT id FROM index_runs WHERE repository_id=$1 ORDER BY id DESC OFFSET $2 LIMIT 1)",
        [scope, keptIndexRuns - 1],
      );
      await this.query("COMMIT");
    } catch (e) {
      await this.query("ROLLBACK");
      throw e;
    }
  }
  async recordFailure(c: ProjectContext, message: string) {
    await this.query(
      `WITH pruned AS (DELETE FROM index_errors WHERE repository_id=$1 AND created_at<now()-interval '30 days')
      INSERT INTO index_errors(repository_id,message) VALUES($1,$2)`,
      [c.projectScopeId, message.slice(0, 2000)],
    );
  }
  async recordIndexProgress(c: ProjectContext, progress: IndexProgress) {
    if (!this.connection) throw new Error("Index progress requires project lock");
    await this.query(
      "INSERT INTO index_jobs(repository_id,backend_pid,data) VALUES($1,pg_backend_pid(),$2) ON CONFLICT(repository_id) DO UPDATE SET backend_pid=EXCLUDED.backend_pid,data=EXCLUDED.data",
      [
        c.projectScopeId,
        JSON.stringify({
          ...progress,
          sessionId: c.sessionId,
          owner: { ...runtimeInfo(), sessionId: c.sessionId },
        }),
      ],
    );
  }
  async status(c: ProjectContext, options: StatusOptions = {}) {
    const limit = options.diagnosticLimit ?? 10,
      offset = options.diagnosticOffset ?? 0;
    if (
      !Number.isInteger(limit) ||
      limit < 1 ||
      limit > 20 ||
      !Number.isInteger(offset) ||
      offset < 0 ||
      offset > 100000
    )
      throw new CodeMemoryError("INVALID_ARGUMENT", "Invalid diagnostic pagination");
    const r = await this.query(
      `WITH last AS (SELECT data FROM index_runs WHERE repository_id=$1 ORDER BY id DESC LIMIT 1),
      diagnostics AS (SELECT value,ordinality FROM last,jsonb_array_elements(COALESCE(data->'diagnostics','[]'::jsonb)) WITH ORDINALITY),
      page AS (SELECT value,ordinality FROM diagnostics ORDER BY ordinality LIMIT $2 OFFSET $3),
      gaps AS (SELECT data->>'status' AS reason,count(*)::int AS files,(array_agg(path ORDER BY path))[1:20] AS "sampleFiles",count(*)>20 AS "hasMoreFiles" FROM files WHERE repository_id=$1 AND data->>'status'<>'INDEXED' GROUP BY data->>'status'),
      reasons AS (SELECT COALESCE(value->>'kind','DIAGNOSTIC') AS reason,count(*)::int AS messages,count(DISTINCT value->>'file')::int AS files,(array_agg(DISTINCT value->>'file' ORDER BY value->>'file'))[1:20] AS "sampleFiles",count(DISTINCT value->>'file')>20 AS "hasMoreFiles" FROM diagnostics GROUP BY COALESCE(value->>'kind','DIAGNOSTIC'))
      SELECT version,fingerprint,indexed_at,
      (version=0 OR EXISTS(SELECT 1 FROM gaps) OR EXISTS(SELECT 1 FROM diagnostics)) AS incomplete,
      (SELECT coalesce(jsonb_agg(errors),'[]'::jsonb) FROM (SELECT path,data->>'error' AS error FROM files WHERE repository_id=$1 AND data->>'status'='INDEX_ERROR' ORDER BY path LIMIT 20) errors) AS "fileErrors",
      COALESCE((SELECT (data->'totals'->>'files')::int FROM last),(SELECT count(*)::int FROM files WHERE repository_id=$1)) AS files,
      COALESCE((SELECT (data->'totals'->>'symbols')::int FROM last),(SELECT count(*)::int FROM symbols WHERE repository_id=$1)) AS symbols,
      COALESCE((SELECT (data->'totals'->>'edges')::int FROM last),(SELECT count(*)::int FROM symbol_edges WHERE repository_id=$1)) AS edges,
      COALESCE((SELECT (data->'totals'->>'unresolvedReferences')::int FROM last),(SELECT count(*)::int FROM unresolved_references WHERE repository_id=$1)) AS "unresolvedReferences",
      (SELECT data || jsonb_build_object('diagnostics',(SELECT COALESCE(jsonb_agg(value ORDER BY ordinality),'[]'::jsonb) FROM page)) FROM last) AS last_run,
      jsonb_build_object('total',(SELECT count(*)::int FROM diagnostics),'affectedFiles',(SELECT count(DISTINCT value->>'file')::int FROM diagnostics)) AS "diagnosticSummary",
      (SELECT COALESCE(jsonb_agg(gaps ORDER BY reason),'[]'::jsonb) FROM gaps) AS "fileGaps",
      (SELECT COALESCE(jsonb_agg(reasons ORDER BY reason),'[]'::jsonb) FROM reasons) AS "diagnosticReasons"
      FROM repositories WHERE id=$1`,
      [c.projectScopeId, limit, offset],
    );
    const row = r.rows[0] ?? { version: 0, incomplete: true };
    const { fileGaps = [], diagnosticReasons = [], ...status } = row;
    const total = row.diagnosticSummary?.total ?? 0;
    const hasMore = offset + limit < total;
    const job = (
      await this.query(
        `SELECT j.data,j.backend_pid AS "databaseBackendPid",
      ${indexLockActive("j.backend_pid", "$1")} AS active
      FROM index_jobs j WHERE j.repository_id=$1`,
        [c.projectScopeId],
      )
    ).rows[0];
    const running = job?.data.state === "RUNNING";
    const updating = running && job.active === true;
    const interrupted = running && !job.active;
    return {
      ...status,
      incomplete: !!row.incomplete || updating,
      freshness: updating ? "UPDATING" : row.version ? "LAST_COMPLETED" : "NOT_READY",
      servedFromVersion: row.version,
      ...(updating ? { staleSince: job.data.startedAt } : {}),
      diagnosticSummary: {
        total,
        affectedFiles: row.diagnosticSummary?.affectedFiles ?? 0,
        limit,
        offset,
        hasMore,
        nextOffset: hasMore ? offset + limit : null,
      },
      incompleteReasons: [
        ...(row.version === 0 ? [{ reason: "NOT_INDEXED" }] : []),
        ...fileGaps,
        ...diagnosticReasons,
      ],
      excludedEntries: row.last_run?.excluded ?? 0,
      exclusions: row.last_run?.exclusions
        ? { available: true, ...row.last_run.exclusions }
        : { available: false, legacyExcludedEntries: row.last_run?.excluded ?? 0 },
      lastIndexJob: job
        ? {
            ...job.data,
            databaseBackendPid: job.databaseBackendPid,
            lockActive: job.active,
            interrupted,
            recovery: interrupted
              ? "Run index for this project to reconcile the last completed graph"
              : undefined,
          }
        : null,
    };
  }
  async saveMemory(c: ProjectContext, m: MemoryEntry, supersedes?: string) {
    await this.withClient(async (conn, broken) => {
      try {
        await conn.query("BEGIN");
        if (m.scope.type === "symbol") {
          const symbol = await conn.query(
            "SELECT 1 FROM symbols WHERE repository_id=$1 AND id=$2 FOR KEY SHARE",
            [c.projectScopeId, m.scope.target],
          );
          if (!symbol.rowCount)
            throw new CodeMemoryError("NOT_FOUND", "Symbol not found in selected project");
        }
        if (supersedes) {
          const old = await conn.query(
            "UPDATE memories SET data=data||jsonb_build_object('status','SUPERSEDED','supersededBy',$3::text,'updatedAt',$4::text) WHERE repository_id=$1 AND id=$2 AND data->>'status'='ACTIVE'",
            [c.projectScopeId, supersedes, m.id, m.updatedAt],
          );
          if (!old.rowCount)
            throw new CodeMemoryError("NOT_FOUND", "Active memory not found in selected project");
        }
        await conn.query("INSERT INTO memories(repository_id,id,data) VALUES($1,$2,$3)", [
          c.projectScopeId,
          m.id,
          JSON.stringify(m),
        ]);
        await conn.query("COMMIT");
      } catch (e) {
        if (!broken()) await conn.query("ROLLBACK");
        throw e;
      }
    }, true);
  }
  async memories(c: ProjectContext): Promise<MemoryEntry[]> {
    return (
      await this.query(
        "SELECT data FROM memories WHERE repository_id=$1 ORDER BY data->>'createdAt' DESC",
        [c.projectScopeId],
      )
    ).rows.map((r) => r.data);
  }
  async searchMemories(c: ProjectContext, q: MemorySearch) {
    if (
      !Number.isInteger(q.limit) ||
      q.limit < 1 ||
      q.limit > 100 ||
      !Number.isInteger(q.offset) ||
      q.offset < 0 ||
      q.offset > 100000
    )
      throw new CodeMemoryError("INVALID_PAGE", "Limit must be 1–100 and offset 0–100000");
    return this.withClient(async (conn, broken) => {
      try {
        await conn.query("BEGIN READ ONLY");
        await conn.query("SET LOCAL statement_timeout='5s'");
        const pattern = `%${q.query.toLowerCase().replace(/[\\%_]/g, "\\$&")}%`;
        const rows = (
          await conn.query<{ data: MemoryEntry }>(
            `
        SELECT data FROM memories WHERE repository_id=$1
          AND ($2::boolean OR data->>'status'='ACTIVE')
          AND (cardinality($3::text[])=0 OR data->>'type'=ANY($3))
          AND (data->'tags') @> $4::jsonb
          AND ($5::text IS NULL OR data#>>'{scope,type}'=$5)
          AND ($6::text[] IS NULL OR data#>>'{scope,target}'=ANY($6))
          AND ($7='' OR lower((data->>'title') || ' ' || (data->>'content') || ' ' || array_to_string(ARRAY(SELECT jsonb_array_elements_text(data->'tags')), ' ')) LIKE $8)
        ORDER BY data->>'createdAt' DESC, id COLLATE "C" LIMIT $9 OFFSET $10`,
            [
              c.projectScopeId,
              q.includeInactive,
              q.types,
              JSON.stringify(q.tags),
              q.scope?.type ?? null,
              q.scope?.target ? (q.scopeTargets ?? [q.scope.target]) : null,
              q.query,
              pattern,
              q.limit + 1,
              q.offset,
            ],
          )
        ).rows;
        await conn.query("COMMIT");
        return {
          results: rows.slice(0, q.limit).map((r) => r.data),
          hasMore: rows.length > q.limit,
          nextOffset: q.offset + q.limit,
        };
      } catch (e) {
        if (!broken()) await conn.query("ROLLBACK");
        if (e && typeof e === "object" && "code" in e && e.code === "57014")
          throw new CodeMemoryError(
            "QUERY_TIMEOUT",
            "Memory query exceeded its execution budget; narrow the query",
          );
        throw e;
      }
    }, true);
  }
  async archiveMemory(c: ProjectContext, id: string) {
    return !!(
      await this.query(
        "UPDATE memories SET data=data||jsonb_build_object('status','ARCHIVED','updatedAt',now()) WHERE repository_id=$1 AND id=$2",
        [c.projectScopeId, id],
      )
    ).rowCount;
  }
  async clean(c: ProjectContext, remove = false) {
    await this.locked(c, async (store) => {
      const db = store as PostgresStore;
      const scope = [c.projectScopeId];
      await db.query("BEGIN");
      try {
        // Large projects outlast the pool's 30 s statement budget. Deleting children set-wise
        // first leaves the per-row FK cascade triggers nothing to do.
        await db.query("SET LOCAL statement_timeout='10min'");
        await db.query("SET LOCAL lock_timeout='30s'");
        for (const table of [
          "symbol_edges",
          "symbols",
          "unresolved_references",
          "files",
          "index_runs",
          // Safe under locked(): no index job of this project can be live.
          "index_jobs",
        ])
          await db.query(`DELETE FROM ${table} WHERE repository_id=$1`, scope);
        if (remove) await db.query("DELETE FROM repositories WHERE id=$1", scope);
        // version stays 0 (not indexed); version_floor keeps later index versions monotonic.
        else
          await db.query(
            "UPDATE repositories SET version_floor=GREATEST(version_floor,version),version=0,indexed_at=NULL,fingerprint='' WHERE id=$1",
            scope,
          );
        await db.query("COMMIT");
      } catch (e) {
        await db.query("ROLLBACK");
        throw e;
      }
    });
  }
  async diagnostics() {
    return {
      database: "connected",
      migrations: (await this.query("SELECT version FROM schema_migrations ORDER BY version")).rows,
      extensions: (
        await this.query("SELECT extname FROM pg_extension WHERE extname IN ('vector','pg_trgm')")
      ).rows,
    };
  }
  async close() {
    if (!this.connection) await this.pool.end();
  }
}

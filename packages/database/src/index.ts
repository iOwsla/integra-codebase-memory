import type {
  IndexMetadata,
  IndexReader,
  IndexResult,
  MemoryEntry,
  MemorySearch,
  ProjectContext,
  ProjectStore,
  Snapshot,
} from "@codememory/core";
import { CodeMemoryError } from "@codememory/core";
import { log, projectName } from "@codememory/shared";
import pg from "pg";
import { PostgresIndexReader } from "./reader";
import { migrations } from "./schema";
export const defaultDatabaseUrl =
  "postgresql://codememory:local-development-only@127.0.0.1:55432/codememory";
export class PostgresStore implements ProjectStore {
  readonly pool: pg.Pool;
  constructor(
    url = process.env.DATABASE_URL ?? defaultDatabaseUrl,
    private readonly connection?: pg.PoolClient,
    pool?: pg.Pool,
  ) {
    this.pool =
      pool ??
      new pg.Pool({
        connectionString: url,
        max: 6,
        connectionTimeoutMillis: 5000,
        statement_timeout: 30000,
      });
    if (!pool) this.pool.on("error", () => log("error", "database_idle_connection_lost"));
  }
  private query(text: string, values: unknown[] = []) {
    return (this.connection ?? this.pool).query(text, values);
  }
  async migrate() {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended('codememory:migrations',0))");
      await c.query(
        "CREATE TABLE IF NOT EXISTS schema_migrations(version integer PRIMARY KEY, applied_at timestamptz NOT NULL DEFAULT now())",
      );
      for (const [index, sql] of migrations.entries()) {
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
    try {
      const lock = await conn.query(
        "SELECT pg_try_advisory_lock(hashtextextended($1,0)) AS acquired",
        [c.projectScopeId],
      );
      if (!lock.rows[0]?.acquired)
        throw new CodeMemoryError(
          "INDEX_BUSY",
          "Selected project is being indexed by another process",
        );
      return await action(new PostgresStore(undefined, conn, this.pool));
    } finally {
      await conn.query("SELECT pg_advisory_unlock(hashtextextended($1,0))", [c.projectScopeId]);
      conn.release();
    }
  }
  async snapshot(c: ProjectContext): Promise<Snapshot> {
    const conn = this.connection ?? (await this.pool.connect());
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
      await conn.query("ROLLBACK");
      throw e;
    } finally {
      if (!this.connection) conn.release();
    }
  }
  async readIndex<T>(
    c: ProjectContext,
    action: (reader: IndexReader, metadata: IndexMetadata) => Promise<T>,
  ): Promise<T> {
    const conn = this.connection ?? (await this.pool.connect());
    const reader = new PostgresIndexReader(conn, c.projectScopeId);
    try {
      await conn.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      await conn.query("SET LOCAL statement_timeout = '5s'");
      await conn.query("SET LOCAL pg_trgm.similarity_threshold = 0.3");
      const repo = (
        await conn.query(
          `
        SELECT version, indexed_at,
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
        freshness: "LAST_COMPLETED",
        incomplete: repo.incomplete,
      });
      await conn.query("COMMIT");
      return result;
    } catch (e) {
      await conn.query("ROLLBACK");
      if (e && typeof e === "object" && "code" in e && e.code === "57014")
        throw new CodeMemoryError(
          "QUERY_TIMEOUT",
          "Scoped index query exceeded its execution budget; narrow the query",
        );
      throw e;
    } finally {
      reader.close();
      if (!this.connection) conn.release();
    }
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
      await this.query("DELETE FROM symbol_edges WHERE repository_id=$1", [scope]);
      await this.query("DELETE FROM unresolved_references WHERE repository_id=$1", [scope]);
      await this.query("DELETE FROM files WHERE repository_id=$1 AND path=ANY($2::text[])", [
        scope,
        deleted,
      ]);
      const batches = async (rows: unknown[], query: string) => {
        for (let offset = 0; offset < rows.length; offset += 500)
          await this.query(query, [scope, JSON.stringify(rows.slice(offset, offset + 500))]);
      };
      await batches(
        s.files.filter((f) => changed.includes(f.path)),
        `INSERT INTO files(repository_id,id,path,data) SELECT $1,j->>'id',j->>'path',j FROM jsonb_array_elements($2::jsonb) j ON CONFLICT(repository_id,id) DO UPDATE SET data=EXCLUDED.data,path=EXCLUDED.path`,
      );
      await this.query("DELETE FROM symbols WHERE repository_id=$1 AND NOT(id=ANY($2::text[]))", [
        scope,
        s.symbols.map((x) => x.id),
      ]);
      await batches(
        s.symbols,
        `INSERT INTO symbols(repository_id,id,file_id,name,qualified_name,data) SELECT $1,j->>'id',j->>'fileId',j->>'name',j->>'qualifiedName',j FROM jsonb_array_elements($2::jsonb) j ON CONFLICT(repository_id,id) DO UPDATE SET data=EXCLUDED.data,name=EXCLUDED.name,qualified_name=EXCLUDED.qualified_name WHERE symbols.data IS DISTINCT FROM EXCLUDED.data`,
      );
      await batches(
        s.edges,
        `INSERT INTO symbol_edges(repository_id,id,source_id,target_id,file_id,edge_type,data) SELECT $1,j->>'id',j->>'source',j->>'target',j->>'fileId',j->>'type',j FROM jsonb_array_elements($2::jsonb) j`,
      );
      await batches(
        s.unresolved,
        `INSERT INTO unresolved_references(repository_id,id,data) SELECT $1,j->>'id',j FROM jsonb_array_elements($2::jsonb) j`,
      );
      await this.query(
        "UPDATE repositories SET version=$2,fingerprint=$3,indexed_at=$4,updated_at=now() WHERE id=$1",
        [scope, s.version, s.fingerprint, s.indexedAt],
      );
      await this.query("INSERT INTO index_runs(repository_id,data) VALUES($1,$2)", [
        scope,
        JSON.stringify({ ...run, sessionId: c.sessionId, diagnostics: s.diagnostics }),
      ]);
      await this.query("COMMIT");
    } catch (e) {
      await this.query("ROLLBACK");
      throw e;
    }
  }
  async recordFailure(c: ProjectContext, message: string) {
    await this.query("INSERT INTO index_errors(repository_id,message) VALUES($1,$2)", [
      c.projectScopeId,
      message.slice(0, 2000),
    ]);
  }
  async status(c: ProjectContext) {
    const r = await this.query(
      `SELECT version,fingerprint,indexed_at, (SELECT count(*)::int FROM files WHERE repository_id=$1) AS files,(SELECT count(*)::int FROM symbols WHERE repository_id=$1) AS symbols,(SELECT count(*)::int FROM symbol_edges WHERE repository_id=$1) AS edges,(SELECT data FROM index_runs WHERE repository_id=$1 ORDER BY id DESC LIMIT 1) AS last_run FROM repositories WHERE id=$1`,
      [c.projectScopeId],
    );
    return r.rows[0] ?? { version: 0 };
  }
  async saveMemory(c: ProjectContext, m: MemoryEntry, supersedes?: string) {
    const conn = await this.pool.connect();
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
      await conn.query("ROLLBACK");
      throw e;
    } finally {
      conn.release();
    }
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
    const conn = await this.pool.connect();
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
      await conn.query("ROLLBACK");
      if (e && typeof e === "object" && "code" in e && e.code === "57014")
        throw new CodeMemoryError(
          "QUERY_TIMEOUT",
          "Memory query exceeded its execution budget; narrow the query",
        );
      throw e;
    } finally {
      conn.release();
    }
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
      await db.query("BEGIN");
      try {
        if (remove) await db.query("DELETE FROM repositories WHERE id=$1", [c.projectScopeId]);
        else {
          await db.query("DELETE FROM files WHERE repository_id=$1", [c.projectScopeId]);
          await db.query("DELETE FROM unresolved_references WHERE repository_id=$1", [
            c.projectScopeId,
          ]);
          await db.query(
            "UPDATE repositories SET version=0,indexed_at=NULL,fingerprint='' WHERE id=$1",
            [c.projectScopeId],
          );
        }
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

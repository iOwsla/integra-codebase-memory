import {
  CodeMemoryError,
  defaultHistorySettings,
  type HistoryBackupRecord,
  type HistoryChange,
  type HistoryCommit,
  type HistoryData,
  type HistoryJob,
  type HistoryRevision,
  type HistorySegment,
  type HistorySettings,
  type HistoryStore,
  type MemoryEntry,
} from "@codememory/core";
import type pg from "pg";
/** Every query is bound to a canonical project ID; uses the existing connection pool. */
export class PostgresHistory implements HistoryStore {
  constructor(
    private readonly pool: pg.Pool,
    private readonly scope: string,
    private readonly connection?: pg.PoolClient,
    private readonly leaseSignal: AbortSignal = new AbortController().signal,
  ) {}
  private async q(sql: string, args: unknown[] = []) {
    try {
      return await (this.connection ?? this.pool).query(sql, [this.scope, ...args]);
    } catch (e) {
      if ((e as { code?: string }).code === "42P01")
        throw new CodeMemoryError(
          "HISTORY_NOT_MIGRATED",
          "Run history configure to prepare the history schema; current code queries remain available",
        );
      throw e;
    }
  }
  async writeBackup(write: (record: HistoryBackupRecord) => Promise<void>) {
    const c = this.connection ?? (await this.pool.connect());
    try {
      await c.query("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY");
      for (const table of backupTables) {
        const filter =
          table === "memories"
            ? "AND id IN (SELECT memory_id FROM history_memory_evidence WHERE repository_id=$1)"
            : "";
        await c.query(
          `DECLARE history_backup_cursor NO SCROLL CURSOR FOR SELECT * FROM ${table} WHERE repository_id=$1 ${filter}`,
          [this.scope],
        );
        for (;;) {
          const rows = (await c.query("FETCH 100 FROM history_backup_cursor")).rows;
          for (const row of rows) await write({ table, row });
          if (rows.length < 100) break;
        }
        await c.query("CLOSE history_backup_cursor");
      }
      await c.query("COMMIT");
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      if (!this.connection) c.release();
    }
  }
  async restoreBackup(records: AsyncIterable<HistoryBackupRecord>) {
    const c = this.connection ?? (await this.pool.connect());
    let count = 0;
    try {
      await c.query("BEGIN");
      for (const table of backupTables) {
        if (
          (await c.query(`SELECT 1 FROM ${table} WHERE repository_id=$1 LIMIT 1`, [this.scope]))
            .rowCount
        )
          throw new CodeMemoryError(
            "HISTORY_RESTORE_CONFLICT",
            "Restore requires an empty selected project history and memory scope",
          );
      }
      for await (const record of records) {
        if (
          !backupTables.includes(record.table as (typeof backupTables)[number]) ||
          record.row.repository_id !== this.scope
        )
          throw new CodeMemoryError(
            "HISTORY_BACKUP_SCOPE",
            "Backup must match the selected canonical project",
          );
        // Restore cannot start workers, enable providers or make an interrupted job run by itself.
        if (record.table === "history_settings")
          record.row = {
            ...record.row,
            documents_enabled: false,
            git_history_enabled: false,
            policy: {
              ...(record.row.policy as HistoryData),
              providers: false,
              automatic: false,
              wip: false,
            },
          };
        if (
          record.table === "history_jobs" &&
          ["QUEUED", "RUNNING"].includes(String(record.row.state))
        )
          record.row = { ...record.row, state: "CANCELLED" };
        await c.query(
          `INSERT INTO ${record.table} SELECT (jsonb_populate_record(NULL::${record.table},$1::jsonb)).*`,
          [record.row],
        );
        count++;
      }
      await c.query("COMMIT");
      return count;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      if (!this.connection) c.release();
    }
  }
  async settings() {
    const r = await this.q(
      "SELECT documents_enabled,git_history_enabled,policy_generation,policy FROM history_settings WHERE repository_id=$1",
    );
    const row = r.rows[0];
    return row
      ? ({
          ...defaultHistorySettings,
          ...row.policy,
          documents: row.documents_enabled,
          git: row.git_history_enabled,
          policyGeneration: row.policy_generation,
        } as HistorySettings)
      : { ...defaultHistorySettings };
  }
  async configure(v: HistorySettings) {
    await this.q(
      `INSERT INTO history_settings(repository_id,documents_enabled,git_history_enabled,policy_generation,policy) VALUES($1,$2,$3,$4,$5)
ON CONFLICT(repository_id) DO UPDATE SET documents_enabled=$2,git_history_enabled=$3,policy_generation=$4,policy=$5,updated_at=now()`,
      [v.documents, v.git, v.policyGeneration, v],
    );
    await this.q(
      "UPDATE history_jobs SET state='CANCELLED',data=data || jsonb_build_object('cancelReason','CONFIGURATION_CHANGED') WHERE repository_id=$1 AND state IN ('QUEUED','RUNNING') AND (kind='COLLECT' OR NOT $2)",
      [v.providers],
    );
  }
  async worktree(id: string, kind: string, data: HistoryData) {
    await this.q(
      "INSERT INTO history_worktrees(repository_id,id,kind,data) VALUES($1,$2,$3,$4) ON CONFLICT(repository_id,id) DO UPDATE SET data=$4",
      [id, kind, data],
    );
  }
  async getRevision(id: string) {
    const r = await this.q(
      'SELECT id,worktree_id AS "worktreeId",source_kind AS "sourceKind",origin,path,object_id AS "objectId",content_hash AS "contentHash",data FROM history_revisions WHERE repository_id=$1 AND id=$2',
      [id],
    );
    return r.rows[0] as HistoryRevision | undefined;
  }
  async nextJob(providers: boolean) {
    return (
      await this.q(
        "SELECT id,kind,state,data,attempts FROM history_jobs WHERE repository_id=$1 AND state IN ('QUEUED','RUNNING') AND (kind='COLLECT' OR $2) ORDER BY CASE WHEN kind='INTERPRET' THEN 0 ELSE 1 END,created_at,id LIMIT 1",
        [providers],
      )
    ).rows[0] as HistoryJob | undefined;
  }
  async revision(v: HistoryRevision, segments: HistorySegment[]) {
    const connection = this.connection ?? (await this.pool.connect());
    try {
      await connection.query("BEGIN");
      const scoped = new PostgresHistory(this.pool, this.scope, connection);
      await scoped.q(
        "INSERT INTO history_revisions(repository_id,id,worktree_id,source_kind,origin,path,object_id,content_hash,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9) ON CONFLICT DO NOTHING",
        [
          v.id,
          v.worktreeId,
          v.sourceKind,
          v.origin,
          v.path,
          v.objectId ?? null,
          v.contentHash,
          v.data,
        ],
      );
      for (let offset = 0; offset < segments.length; offset += 200) {
        await scoped.q(
          `INSERT INTO history_segments(repository_id,revision_id,segmenter,ordinal,id,kind,start_line,end_line,start_byte,end_byte,content_hash,excerpt,data)
SELECT $1,$2,'markdown-1',s.ordinal,s.id,s.kind,s."startLine",s."endLine",s."startByte",s."endByte",s."contentHash",s.excerpt,jsonb_build_object('headingPath',s."headingPath")
FROM jsonb_to_recordset($3::jsonb) AS s(ordinal int,id text,kind text,"startLine" int,"endLine" int,"startByte" int,"endByte" int,"contentHash" text,excerpt text,"headingPath" jsonb) ON CONFLICT DO NOTHING`,
          [v.id, JSON.stringify(segments.slice(offset, offset + 200))],
        );
      }
      await connection.query("COMMIT");
    } catch (error) {
      await connection.query("ROLLBACK");
      throw error;
    } finally {
      if (!this.connection) connection.release();
    }
  }
  async wipEntry(
    w: string,
    path: string,
    layer: string,
    revision: string | null,
    scan: string,
    data: HistoryData,
  ) {
    await this.q(
      `INSERT INTO history_wip_entries(repository_id,worktree_id,path,layer,revision_id,observed_at,data) VALUES($1,$2,$3,$4,$5,$6,$7)
ON CONFLICT(repository_id,worktree_id,path,layer) DO UPDATE SET revision_id=$5,state='ACTIVE',observed_at=$6,data=$7`,
      [w, path, layer, revision, scan, data],
    );
  }
  async reconcileWip(w: string, scan: string) {
    await this.q(
      "UPDATE history_wip_entries SET state='RESOLVED_RECHECK_HISTORY' WHERE repository_id=$1 AND worktree_id=$2 AND observed_at < $3::timestamptz",
      [w, scan],
    );
  }
  async documentHead(w: string, path: string, revision: string, scan: string) {
    await this.q(
      `INSERT INTO history_document_heads(repository_id,worktree_id,path,state,revision_id,observed_at) VALUES($1,$2,$3,'PRESENT',$4,$5::timestamptz)
ON CONFLICT(repository_id,worktree_id,path) DO UPDATE SET previous_revision_id=CASE WHEN history_document_heads.revision_id IS DISTINCT FROM $4 THEN history_document_heads.revision_id ELSE history_document_heads.previous_revision_id END,revision_id=$4,state='PRESENT',observed_at=$5::timestamptz`,
      [w, path, revision, scan],
    );
  }
  async reconcileDocuments(w: string, scan: string) {
    await this.q(
      "UPDATE history_document_heads SET state='MISSING_OR_EXCLUDED' WHERE repository_id=$1 AND worktree_id=$2 AND observed_at < $3::timestamptz",
      [w, scan],
    );
  }
  async commit(v: HistoryCommit) {
    await this.q(
      "INSERT INTO history_commits(repository_id,object_id,object_format,tree_id,parent_ids,committed_at,data) VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT(repository_id,object_id) DO UPDATE SET data=history_commits.data || EXCLUDED.data",
      [v.id, v.objectFormat, v.tree, v.parents, v.committedAt, v.data],
    );
  }
  async change(v: HistoryChange) {
    await this.q(
      "INSERT INTO history_file_changes(repository_id,id,commit_id,comparison_parent,change_kind,old_path,new_path,old_object_id,new_object_id,data) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) ON CONFLICT DO NOTHING",
      [
        v.id,
        v.commitId,
        v.parent,
        v.kind,
        v.oldPath,
        v.newPath,
        v.oldObjectId,
        v.newObjectId,
        v.data,
      ],
    );
  }
  async cursor(w: string, stream: string, data?: HistoryData) {
    if (data)
      await this.q(
        "INSERT INTO history_cursors(repository_id,worktree_id,stream,data) VALUES($1,$2,$3,$4) ON CONFLICT(repository_id,worktree_id,stream) DO UPDATE SET data=$4,updated_at=now()",
        [w, stream, data],
      );
    return (
      await this.q(
        "SELECT data FROM history_cursors WHERE repository_id=$1 AND worktree_id=$2 AND stream=$3",
        [w, stream],
      )
    ).rows[0]?.data as HistoryData | undefined;
  }
  async enqueue(job: HistoryJob, dedupe: string) {
    const row = await this.q(
      "INSERT INTO history_jobs(repository_id,id,kind,dedupe_key,state,data) VALUES($1,$2,$3,$4,'QUEUED',$5) ON CONFLICT(repository_id,dedupe_key) WHERE state IN ('QUEUED','RUNNING') DO UPDATE SET dedupe_key=EXCLUDED.dedupe_key RETURNING id",
      [job.id, job.kind, dedupe, job.data],
    );
    return row.rows[0].id as string;
  }
  async job(id: string) {
    const r = await this.q(
      "SELECT id,kind,state,data,created_at,attempts FROM history_jobs WHERE repository_id=$1 AND id=$2",
      [id],
    );
    return r.rows[0] as HistoryJob | undefined;
  }
  async saveJob(job: HistoryJob) {
    const result = await this.q(
      `UPDATE history_jobs SET state=$3,data=CASE WHEN $3='RUNNING' THEN jsonb_set($4::jsonb,'{owner}',coalesce($4::jsonb->'owner','{}') || jsonb_build_object('databaseBackendPid',pg_backend_pid(),'leaseMode','SESSION_LOCK')) ELSE $4::jsonb END,
updated_at=now(),attempts=attempts+CASE WHEN $3='RUNNING' AND state<>'RUNNING' THEN 1 ELSE 0 END WHERE repository_id=$1 AND id=$2 RETURNING data`,
      [job.id, job.state, job.data],
    );
    if (result.rows[0]) job.data = result.rows[0].data;
  }
  async runExclusive<T>(
    action: (store: HistoryStore, leaseSignal: AbortSignal) => Promise<T>,
  ): Promise<T> {
    if (this.connection) return action(this, this.leaseSignal);
    const c = await this.pool.connect();
    const lease = new AbortController();
    let acquired = false;
    let failed: Error | undefined;
    const onError = (e: Error) => {
      failed = e;
      lease.abort();
    };
    c.on("error", onError);
    try {
      acquired =
        (
          await c.query(
            "SELECT pg_try_advisory_lock(hashtextextended('codememory:history-worker',0)) AS ok",
          )
        ).rows[0]?.ok === true;
      if (!acquired)
        throw new CodeMemoryError(
          "HISTORY_BUSY",
          "Another history batch owns the worker; retry after it yields",
        );
      return await action(
        new PostgresHistory(this.pool, this.scope, c, lease.signal),
        lease.signal,
      );
    } finally {
      try {
        if (acquired && !failed)
          await c.query(
            "SELECT pg_advisory_unlock(hashtextextended('codememory:history-worker',0))",
          );
      } finally {
        c.removeListener("error", onError);
        c.release(failed);
      }
    }
  }
  async runModelExclusive<T>(action: (leaseSignal: AbortSignal) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    const lease = new AbortController();
    let acquired = false,
      failed: Error | undefined;
    const error = (e: Error) => {
      failed = e;
      lease.abort();
    };
    c.on("error", error);
    try {
      acquired =
        (
          await c.query(
            "SELECT pg_try_advisory_lock(hashtextextended('codememory:memory-worker',0)) AS ok",
          )
        ).rows[0]?.ok === true;
      if (!acquired)
        throw new CodeMemoryError(
          "HISTORY_MODEL_BUSY",
          "Another conversation/history model job owns the provider worker",
        );
      return await action(lease.signal);
    } finally {
      try {
        if (acquired && !failed)
          await c.query(
            "SELECT pg_advisory_unlock(hashtextextended('codememory:memory-worker',0))",
          );
      } finally {
        c.removeListener("error", error);
        c.release(failed);
      }
    }
  }
  async list(
    kind: "documents" | "changes" | "jobs" | "segments" | "wip" | "intent",
    query: string,
    path: string,
    limit: number,
    offset: number,
    revision?: string,
  ) {
    let sql: string;
    const args: unknown[] = [query, path, limit + 1, offset];
    if (kind === "documents")
      sql = `SELECT h.path,h.state,h.revision_id,h.previous_revision_id,r.content_hash,r.data FROM history_document_heads h JOIN history_revisions r ON (r.repository_id,r.id)=(h.repository_id,h.revision_id) WHERE h.repository_id=$1 AND ($3='' OR h.path=$3) AND ($2='' OR position(lower($2) in lower(h.path))>0) ORDER BY h.path LIMIT $4 OFFSET $5`;
    else if (kind === "wip") {
      sql = `SELECT e.path,e.layer,e.state,e.revision_id,e.data,r.content_hash FROM history_wip_entries e LEFT JOIN history_revisions r ON (r.repository_id,r.id)=(e.repository_id,e.revision_id) WHERE e.repository_id=$1 AND ($3='' OR e.path=$3) AND ($2='' OR position(lower($2) in lower(e.path))>0) ORDER BY e.path,e.layer LIMIT $4 OFFSET $5`;
    } else if (kind === "segments" || kind === "intent") {
      args.push(revision ?? "");
      sql = `SELECT s.id,s.revision_id,r.path,s.start_line,s.end_line,s.start_byte,s.end_byte,s.excerpt,s.data,r.content_hash,r.origin FROM history_segments s JOIN history_revisions r ON (r.repository_id,r.id)=(s.repository_id,s.revision_id) WHERE s.repository_id=$1 ${kind === "intent" ? "AND r.source_kind='DOCUMENT' AND EXISTS(SELECT 1 FROM history_document_heads h WHERE (h.repository_id,h.revision_id)=(r.repository_id,r.id) AND h.state='PRESENT')" : ""} AND ($3='' OR r.path=$3) AND ($6='' OR r.id=$6) AND ($2='' OR to_tsvector('simple',coalesce(s.excerpt,'')) @@ plainto_tsquery('simple',$2)) ORDER BY r.path,s.revision_id,s.ordinal LIMIT $4 OFFSET $5`;
    } else if (kind === "changes")
      sql = `SELECT f.*,c.committed_at FROM history_file_changes f JOIN history_commits c ON (c.repository_id,c.object_id)=(f.repository_id,f.commit_id) WHERE f.repository_id=$1 AND ($3='' OR f.new_path=$3 OR f.old_path=$3) AND ($2='' OR to_tsvector('simple',coalesce(f.new_path,'') || ' ' || coalesce(f.old_path,'') || ' ' || f.data::text) @@ plainto_tsquery('simple',$2)) ORDER BY c.committed_at DESC,f.id LIMIT $4 OFFSET $5`;
    else
      sql = `SELECT id,kind,state,created_at,updated_at,(data - 'evidenceSegments' - 'candidates') AS data,jsonb_array_length(coalesce(data->'candidates','[]')) AS candidate_count,attempts FROM history_jobs WHERE repository_id=$1 AND ($2='' OR id=$2) AND ($3='' OR kind=$3) ORDER BY created_at DESC,id LIMIT $4 OFFSET $5`;
    const r = await this.q(sql, args);
    const results = r.rows
      .slice(0, limit)
      .map(({ repository_id: _, ...row }) => row as HistoryData);
    return {
      results,
      hasMore: r.rows.length > limit,
      nextOffset: r.rows.length > limit ? offset + results.length : null,
    };
  }
  async evidence(ids: string[]) {
    return (
      await this.q(
        `SELECT s.id,s.revision_id,s.start_line,s.end_line,s.start_byte,s.end_byte,s.excerpt,r.path,r.source_kind,r.origin,r.content_hash,r.data FROM history_segments s JOIN history_revisions r ON (r.repository_id,r.id)=(s.repository_id,s.revision_id) WHERE s.repository_id=$1 AND s.id=ANY($2::text[])`,
        [ids],
      )
    ).rows as HistoryData[];
  }
  async memoryEvidence(ids: string[]) {
    return (
      await this.q(
        "SELECT memory_id,segment_id FROM history_memory_evidence WHERE repository_id=$1 AND memory_id=ANY($2::text[]) ORDER BY memory_id,segment_id LIMIT 31",
        [ids],
      )
    ).rows as HistoryData[];
  }
  async stats() {
    return (
      await this.q(
        `SELECT (SELECT count(*)::int FROM history_revisions WHERE repository_id=$1) AS revisions,(SELECT count(*)::int FROM history_commits WHERE repository_id=$1) AS commits,(SELECT count(*)::int FROM history_file_changes WHERE repository_id=$1) AS changes,(SELECT coalesce(sum(octet_length(excerpt)),0)::float8 FROM history_segments WHERE repository_id=$1) AS "excerptBytes",(SELECT count(*)::int FROM history_jobs WHERE repository_id=$1 AND state IN ('QUEUED','RUNNING')) AS pending`,
      )
    ).rows[0] as HistoryData;
  }
  async promote(
    jobId: string,
    candidateId: string,
    memory: MemoryEntry,
    userApproval: string,
    supersedes?: string,
  ) {
    const c = await this.pool.connect();
    try {
      await c.query("BEGIN");
      await c.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `history-promotion:${this.scope}`,
      ]);
      const row = (
        await c.query(
          "SELECT data,state FROM history_jobs WHERE repository_id=$1 AND id=$2 FOR UPDATE",
          [this.scope, jobId],
        )
      ).rows[0];
      const candidate = row?.data.candidates?.find((v: HistoryData) => v.id === candidateId);
      if (candidate?.memoryId) {
        if (supersedes)
          throw new CodeMemoryError(
            "MEMORY_REVIEW_CONFLICT",
            "Candidate is already approved; review a separate replacement",
          );
        await c.query("COMMIT");
        return candidate.memoryId as string;
      }
      if (
        row?.state !== "READY" ||
        candidate?.state !== "READY" ||
        candidate?.verdict !== "SUPPORTED" ||
        !["REQUIREMENT", "ACCEPTED_DECISION"].includes(candidate.classification) ||
        !candidate.evidence?.every((e: HistoryData) => e.source_kind === "DOCUMENT")
      )
        throw new CodeMemoryError(
          "INVALID_CANDIDATE",
          "Only an exact verified candidate can be promoted",
        );
      if (memory.content !== candidate.claim)
        throw new CodeMemoryError("INVALID_CANDIDATE", "Claim does not match reviewed evidence");
      if (supersedes) {
        const duplicate = await c.query(
          "SELECT id FROM memories WHERE repository_id=$1 AND data->>'content'=$2 AND data->>'status'='ACTIVE'",
          [this.scope, memory.content],
        );
        if (duplicate.rowCount)
          throw new CodeMemoryError(
            "MEMORY_REVIEW_CONFLICT",
            "An identical active rule exists; inspect it before replacement",
          );
        const old = await c.query(
          "UPDATE memories SET data=jsonb_set(data,'{status}','\"SUPERSEDED\"'::jsonb) WHERE repository_id=$1 AND id=$2 AND data->>'status'='ACTIVE' RETURNING id",
          [this.scope, supersedes],
        );
        if (!old.rowCount)
          throw new CodeMemoryError(
            "NOT_FOUND",
            "Active same-project memory to supersede not found",
          );
      }
      const duplicate = (
        await c.query(
          "SELECT id FROM memories WHERE repository_id=$1 AND data->>'content'=$2 AND data->>'status'='ACTIVE' LIMIT 1",
          [this.scope, memory.content],
        )
      ).rows[0]?.id;
      const memoryId = duplicate ?? memory.id;
      if (!duplicate)
        await c.query("INSERT INTO memories(repository_id,id,data) VALUES($1,$2,$3)", [
          this.scope,
          memory.id,
          memory,
        ]);
      for (const evidence of candidate.evidence as HistoryData[]) {
        await c.query(
          "INSERT INTO history_memory_evidence(repository_id,memory_id,segment_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING",
          [this.scope, memoryId, evidence.id],
        );
      }
      candidate.memoryId = memoryId;
      candidate.state = "APPROVED";
      candidate.userApproval = userApproval;
      await c.query(
        "UPDATE history_jobs SET data=$3,updated_at=now() WHERE repository_id=$1 AND id=$2",
        [this.scope, jobId, row.data],
      );
      await c.query("COMMIT");
      return memoryId as string;
    } catch (e) {
      await c.query("ROLLBACK");
      throw e;
    } finally {
      c.release();
    }
  }
  async cleanup(days: number, purge: boolean, apply: boolean) {
    const filter = purge
      ? "true"
      : "r.origin='WIP' AND r.captured_at < now()-($2::int * interval '1 day')";
    const args = purge ? [] : [days];
    const count = (
      await this.q(
        `SELECT count(*)::int AS count FROM history_segments s JOIN history_revisions r ON (r.repository_id,r.id)=(s.repository_id,s.revision_id) WHERE s.repository_id=$1 AND s.excerpt IS NOT NULL AND ${filter}`,
        args,
      )
    ).rows[0]?.count;
    if (apply)
      await this.q(
        `UPDATE history_segments s SET excerpt=NULL WHERE s.repository_id=$1 AND EXISTS(SELECT 1 FROM history_revisions r WHERE (r.repository_id,r.id)=(s.repository_id,s.revision_id) AND ${filter})`,
        args,
      );
    // Source-derived jobs contain exact excerpts too. Purging removes their payload but preserves audit IDs.
    if (apply && purge)
      await this.q(
        "UPDATE history_jobs SET state='PURGED',data=jsonb_build_object('evidenceState','SOURCE_UNAVAILABLE') WHERE repository_id=$1",
      );
    return {
      apply,
      purge,
      segments: count,
      evidenceState: apply ? "SOURCE_UNAVAILABLE" : "PREVIEW",
      retained: "Source identities and active memories remain; claims require evidence review",
    };
  }
}

const backupTables = [
  "memories",
  "history_settings",
  "history_worktrees",
  "history_revisions",
  "history_segments",
  "history_document_heads",
  "history_wip_entries",
  "history_commits",
  "history_file_changes",
  "history_jobs",
  "history_cursors",
  "history_memory_evidence",
] as const;

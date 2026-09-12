import { createHash, randomUUID } from "node:crypto";
import {
  CodeMemoryError,
  type MemoryBatch,
  type MemoryCandidate,
  type MemoryCheckpoint,
  type MemoryEntry,
  type MemoryJob,
  type ProjectContext,
} from "@codememory/core";
import type pg from "pg";

export class MemoryWorkflowRepository {
  constructor(readonly pool: pg.Pool) {}
  async saveMemoryCheckpoint(c: ProjectContext, checkpoint: MemoryCheckpoint) {
    const client = await this.pool.connect();
    try {
      await client.query("BEGIN");
      const memory = await client.query(
        "SELECT data FROM memories WHERE repository_id=$1 AND id=$2 FOR UPDATE",
        [c.projectScopeId, checkpoint.memoryId],
      );
      if (memory.rows[0]?.data.status !== "ACTIVE")
        throw new CodeMemoryError("NOT_FOUND", "Active memory not found in selected project");
      await client.query(
        "INSERT INTO memory_checkpoints(repository_id,memory_id,id,created_at,data) VALUES($1,$2,$3,$4,$5)",
        [c.projectScopeId, checkpoint.memoryId, checkpoint.id, checkpoint.createdAt, checkpoint],
      );
      await client.query("COMMIT");
    } catch (error) {
      await client.query("ROLLBACK");
      throw error;
    } finally {
      client.release();
    }
  }
  async memoryCheckpoints(
    c: ProjectContext,
    memoryId: string,
    limit: number,
    offset: number,
  ): Promise<MemoryCheckpoint[]> {
    try {
      return (
        await this.pool.query(
          "SELECT data FROM memory_checkpoints WHERE repository_id=$1 AND memory_id=$2 ORDER BY created_at DESC,id DESC LIMIT $3 OFFSET $4",
          [c.projectScopeId, memoryId, limit, offset],
        )
      ).rows.map((r) => r.data);
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "42P01")
        return [];
      throw error;
    }
  }
  async memoryWorkflowEnabled(c: ProjectContext) {
    try {
      return (
        (
          await this.pool.query(
            "SELECT enabled FROM memory_workflow_settings WHERE repository_id=$1",
            [c.projectScopeId],
          )
        ).rows[0]?.enabled === true
      );
    } catch (error) {
      if (error && typeof error === "object" && "code" in error && error.code === "42P01")
        return false;
      throw error;
    }
  }
  async configureMemoryWorkflow(c: ProjectContext, enabled: boolean) {
    await this.pool.query(
      "INSERT INTO memory_workflow_settings(repository_id,enabled) VALUES($1,$2) ON CONFLICT(repository_id) DO UPDATE SET enabled=$2",
      [c.projectScopeId, enabled],
    );
  }
  async enqueueMemory(c: ProjectContext, input: MemoryBatch) {
    const job: MemoryJob = {
      id: randomUUID(),
      state: "QUEUED",
      input,
      candidates: [],
      attempts: 0,
      createdAt: new Date().toISOString(),
    };
    const hash = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const inserted = await this.pool.query(
      `INSERT INTO memory_jobs(repository_id,id,session_id,batch_id,input_hash,data) SELECT $1,$2,$3,$4,$5,$6 WHERE EXISTS(SELECT 1 FROM memory_workflow_settings WHERE repository_id=$1 AND enabled) ON CONFLICT(repository_id,session_id,batch_id) DO NOTHING RETURNING id`,
      [c.projectScopeId, job.id, input.sessionId, input.batchId, hash, JSON.stringify(job)],
    );
    if (inserted.rowCount) return { job, duplicate: false };
    const old = (
      await this.pool.query(
        "SELECT data,input_hash FROM memory_jobs WHERE repository_id=$1 AND session_id=$2 AND batch_id=$3",
        [c.projectScopeId, input.sessionId, input.batchId],
      )
    ).rows[0];
    if (!old)
      throw new CodeMemoryError(
        "MEMORY_DISABLED",
        "Enable this project with memory configure --enable --yes before submitting excerpts",
      );
    if (old.input_hash !== hash)
      throw new CodeMemoryError(
        "EVIDENCE_CONFLICT",
        "Batch identity already exists with different evidence; use a new batch ID",
      );
    return { job: old.data as MemoryJob, duplicate: true };
  }
  async memoryJobs(c: ProjectContext, limit: number, offset: number) {
    const rows = (
      await this.pool.query(
        "SELECT data FROM memory_jobs WHERE repository_id=$1 ORDER BY created_at DESC,id LIMIT $2 OFFSET $3",
        [c.projectScopeId, limit + 1, offset],
      )
    ).rows;
    return {
      results: rows.slice(0, limit).map((r) => r.data as MemoryJob),
      hasMore: rows.length > limit,
      nextOffset: offset + limit,
    };
  }
  async memoryJob(c: ProjectContext, id: string): Promise<MemoryJob> {
    const row = (
      await this.pool.query("SELECT data FROM memory_jobs WHERE repository_id=$1 AND id=$2", [
        c.projectScopeId,
        id,
      ])
    ).rows[0];
    if (!row) throw new CodeMemoryError("NOT_FOUND", "Memory job not found in selected project");
    return row.data;
  }
  async retryMemoryJob(c: ProjectContext, id: string) {
    const r = await this.pool.query(
      `UPDATE memory_jobs SET state='QUEUED',data=(data-'error'-'errorMessage'-'diagnosticId'-'owner'-'phase')||'{"state":"QUEUED"}'::jsonb WHERE repository_id=$1 AND id=$2 AND state='FAILED' AND (data->>'attempts')::int<3`,
      [c.projectScopeId, id],
    );
    if (!r.rowCount)
      throw new CodeMemoryError(
        "MEMORY_RETRY_REJECTED",
        "Only failed jobs with fewer than three attempts can be retried",
      );
  }
  async workMemory(
    c: ProjectContext,
    run: (
      job: MemoryJob,
      progress: (phase: string, metrics?: Record<string, unknown>) => Promise<void>,
      leaseSignal: AbortSignal,
    ) => Promise<Pick<MemoryJob, "candidates" | "metrics">>,
  ) {
    const conn = await this.pool.connect();
    let acquired = false;
    let connectionError: Error | undefined;
    const lease = new AbortController();
    const onError = (error: Error) => {
      connectionError = error;
      lease.abort();
    };
    conn.on("error", onError);
    try {
      acquired = (
        await conn.query(
          "SELECT pg_try_advisory_lock(hashtextextended('codememory:memory-worker',0)) AS acquired",
        )
      ).rows[0].acquired;
      if (!acquired || !(await this.memoryWorkflowEnabled(c))) return false;
      // Owning the global session lock proves no other live worker owns RUNNING jobs.
      const row = (
        await conn.query(
          `SELECT data FROM memory_jobs WHERE repository_id=$1 AND state IN ('QUEUED','RUNNING') ORDER BY created_at,id LIMIT 1`,
          [c.projectScopeId],
        )
      ).rows[0];
      if (!row) return false;
      const job = row.data as MemoryJob;
      job.state = "RUNNING";
      job.attempts++;
      job.owner = { pid: process.pid, sessionId: c.sessionId, startedAt: new Date().toISOString() };
      await conn.query(
        "UPDATE memory_jobs SET state='RUNNING',data=$3 WHERE repository_id=$1 AND id=$2",
        [c.projectScopeId, job.id, JSON.stringify(job)],
      );
      try {
        if (job.attempts > 3)
          throw new CodeMemoryError("MEMORY_RETRY_EXHAUSTED", "Retry budget exhausted");
        Object.assign(
          job,
          await run(
            job,
            async (phase, metrics) => {
              if (connectionError) throw connectionError;
              job.phase = phase;
              if (metrics) job.metrics = metrics;
              await conn.query("UPDATE memory_jobs SET data=$3 WHERE repository_id=$1 AND id=$2", [
                c.projectScopeId,
                job.id,
                JSON.stringify(job),
              ]);
            },
            lease.signal,
          ),
        );
        if (connectionError) throw connectionError;
        if (!(await this.memoryWorkflowEnabled(c)))
          throw new CodeMemoryError("MEMORY_DISABLED", "Project disabled during processing");
        job.state = "SUCCEEDED";
      } catch (error) {
        job.state = "FAILED";
        job.candidates = [];
        job.error = error instanceof CodeMemoryError ? error.code : "MEMORY_PROVIDER_ERROR";
        job.errorMessage =
          error instanceof CodeMemoryError
            ? error.message
            : "Model output or provider failed validation";
        job.diagnosticId = randomUUID();
      }
      if (connectionError) throw connectionError;
      await conn.query("UPDATE memory_jobs SET state=$3,data=$4 WHERE repository_id=$1 AND id=$2", [
        c.projectScopeId,
        job.id,
        job.state,
        JSON.stringify(job),
      ]);
      return true;
    } finally {
      try {
        if (acquired && !connectionError)
          await conn.query(
            "SELECT pg_advisory_unlock(hashtextextended('codememory:memory-worker',0))",
          );
      } finally {
        conn.removeListener("error", onError);
        conn.release(connectionError);
      }
    }
  }
  async reviewMemory(
    c: ProjectContext,
    jobId: string,
    candidateId: string,
    approval: string,
    reject: boolean,
    supersedes?: string,
  ) {
    const conn = await this.pool.connect();
    try {
      await conn.query("BEGIN");
      await conn.query("SELECT pg_advisory_xact_lock(hashtextextended($1,0))", [
        `memory-review:${c.projectScopeId}`,
      ]);
      const row = (
        await conn.query(
          "SELECT data FROM memory_jobs WHERE repository_id=$1 AND id=$2 FOR UPDATE",
          [c.projectScopeId, jobId],
        )
      ).rows[0];
      const job = row?.data as MemoryJob | undefined;
      const candidate = job?.candidates.find((x) => x.id === candidateId);
      if (!job || !candidate)
        throw new CodeMemoryError("NOT_FOUND", "Candidate not found in selected project");
      let memory: MemoryEntry | undefined;
      if (candidate.state === "PROMOTED") {
        memory = (
          await conn.query("SELECT data FROM memories WHERE repository_id=$1 AND id=$2", [
            c.projectScopeId,
            candidate.memoryId,
          ])
        ).rows[0]?.data;
        if (reject || supersedes)
          throw new CodeMemoryError(
            "MEMORY_REVIEW_CONFLICT",
            "Candidate already promoted; archive or supersede the memory explicitly",
          );
      } else if (reject) candidate.state = "REJECTED";
      else {
        if (
          job.state !== "SUCCEEDED" ||
          candidate.state !== "READY" ||
          candidate.verdict !== "SUPPORTED" ||
          !["REQUIREMENT", "ACCEPTED_DECISION"].includes(candidate.classification)
        )
          throw new CodeMemoryError(
            "MEMORY_NOT_VERIFIED",
            "Only verified rule candidates can be promoted",
          );
        const now = new Date().toISOString();
        // Exact duplicates reuse an active same-project record; no semantic auto-merges.
        memory = (
          await conn.query(
            `SELECT data FROM memories WHERE repository_id=$1 AND data->>'status'='ACTIVE' AND data#>>'{scope,type}'='repository' AND data->>'content'=$2 ORDER BY id LIMIT 1`,
            [c.projectScopeId, candidate.claim],
          )
        ).rows[0]?.data;
        if (memory && supersedes)
          throw new CodeMemoryError(
            "MEMORY_REVIEW_CONFLICT",
            "Duplicate active memory exists; review replacement explicitly",
          );
        if (!memory) {
          memory = {
            id: randomUUID(),
            type: candidate.classification === "REQUIREMENT" ? "CONVENTION" : "DECISION",
            title: candidate.claim.slice(0, 200),
            content: candidate.claim,
            scope: { type: "repository" },
            tags: ["verified-candidate"],
            priority: 5,
            status: "ACTIVE",
            source: `memory-job:${job.id}:${candidate.id}`,
            createdAt: now,
            updatedAt: now,
          };
          if (supersedes) {
            const updated = await conn.query(
              `UPDATE memories SET data=data||jsonb_build_object('status','SUPERSEDED','supersededBy',$3::text,'updatedAt',$4::text) WHERE repository_id=$1 AND id=$2 AND data->>'status'='ACTIVE'`,
              [c.projectScopeId, supersedes, memory.id, now],
            );
            if (!updated.rowCount)
              throw new CodeMemoryError(
                "NOT_FOUND",
                "Active replacement target not found in selected project",
              );
          }
          await conn.query("INSERT INTO memories(repository_id,id,data) VALUES($1,$2,$3)", [
            c.projectScopeId,
            memory.id,
            JSON.stringify(memory),
          ]);
        }
        candidate.state = "PROMOTED";
        candidate.memoryId = memory.id;
      }
      candidate.review ??= {
        action: reject ? "REJECT" : "APPROVE",
        userApproval: approval,
        reviewedAt: new Date().toISOString(),
      };
      await conn.query("UPDATE memory_jobs SET data=$3 WHERE repository_id=$1 AND id=$2", [
        c.projectScopeId,
        jobId,
        JSON.stringify(job),
      ]);
      await conn.query("COMMIT");
      return { candidate: candidate as MemoryCandidate, memory };
    } catch (e) {
      await conn.query("ROLLBACK");
      throw e;
    } finally {
      conn.release();
    }
  }
  async recallMemories(
    c: ProjectContext,
    query: string,
    paths: string[],
    symbols: string[],
    limit: number,
  ) {
    const sql = `WITH ranked AS (
      SELECT data,id,CASE WHEN EXISTS (
        SELECT 1 FROM jsonb_array_elements(COALESCE((
          SELECT cp.data->'links' FROM memory_checkpoints cp
          WHERE cp.repository_id=$1 AND cp.memory_id=memories.id
          ORDER BY cp.created_at DESC,cp.id DESC LIMIT 1
        ),'[]'::jsonb)) link WHERE link->>'path'=ANY($3::text[])
      ) THEN 5 ELSE CASE data#>>'{scope,type}' WHEN 'symbol' THEN 4 WHEN 'file' THEN 3 WHEN 'directory' THEN 2 ELSE 1 END END AS scope_rank,
      ts_rank(to_tsvector('simple',(data->>'title') || ' ' || (data->>'content')),plainto_tsquery('simple',$2)) AS relevance
      FROM memories WHERE repository_id=$1 AND data->>'status'='ACTIVE' AND (
        data#>>'{scope,type}'='repository' OR
        (data#>>'{scope,type}'='file' AND data#>>'{scope,target}'=ANY($3::text[])) OR
        (data#>>'{scope,type}'='symbol' AND data#>>'{scope,target}'=ANY($4::text[])) OR
        (data#>>'{scope,type}'='directory' AND EXISTS(SELECT 1 FROM unnest($3::text[]) p WHERE data#>>'{scope,target}'='.' OR p=data#>>'{scope,target}' OR starts_with(p,(data#>>'{scope,target}')||'/')))
      )) SELECT data FROM ranked ORDER BY scope_rank DESC,relevance DESC,(data->>'priority')::int DESC,data->>'createdAt' DESC,id LIMIT $5`;
    let rows: { data: MemoryEntry }[];
    try {
      rows = (await this.pool.query(sql, [c.projectScopeId, query, paths, symbols, limit + 1]))
        .rows;
    } catch (error) {
      // Preserve recall for pre-checkpoint installations until migrations run.
      if (!(error && typeof error === "object" && "code" in error && error.code === "42P01"))
        throw error;
      const legacy = sql
        .replace(/CASE WHEN EXISTS \([\s\S]*?THEN 5 ELSE CASE/, "CASE")
        .replace("ELSE 1 END END AS scope_rank", "ELSE 1 END AS scope_rank");
      rows = (await this.pool.query(legacy, [c.projectScopeId, query, paths, symbols, limit + 1]))
        .rows;
    }
    return {
      results: rows.slice(0, limit).map((r) => r.data as MemoryEntry),
      hasMore: rows.length > limit,
    };
  }
}

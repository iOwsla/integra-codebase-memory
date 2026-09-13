import { CodebaseService } from "@codememory/application";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it } from "vitest";

const historyTables = [
  "history_commits",
  "history_cursors",
  "history_document_heads",
  "history_file_changes",
  "history_jobs",
  "history_memory_evidence",
  "history_revisions",
  "history_segments",
  "history_settings",
  "history_wip_entries",
  "history_worktrees",
];
const insert = {
  settings: "INSERT INTO history_settings(repository_id,documents_enabled) VALUES($1,true)",
  worktree:
    "INSERT INTO history_worktrees(repository_id,id,kind,data) VALUES($1,$2,'FILESYSTEM','{}')",
  revision:
    "INSERT INTO history_revisions(repository_id,id,worktree_id,source_kind,origin,path,content_hash,data) VALUES($1,$2,$3,'DOCUMENT','WORKING_TREE','README.md','hash','{}')",
  segment:
    "INSERT INTO history_segments(repository_id,revision_id,segmenter,ordinal,id,kind,start_line,end_line,start_byte,end_byte,content_hash,excerpt,data) VALUES($1,$2,'markdown-1',0,$3,'HEADING',1,1,0,3,'hash','# A','{}')",
  head: "INSERT INTO history_document_heads(repository_id,worktree_id,path,state,revision_id) VALUES($1,$2,'README.md','PRESENT',$3)",
  commit:
    "INSERT INTO history_commits(repository_id,object_id,object_format,tree_id,parent_ids,data) VALUES($1,$2,'sha1','tree','{}','{}')",
  change:
    "INSERT INTO history_file_changes(repository_id,id,commit_id,comparison_parent,change_kind,new_path,new_object_id,data) VALUES($1,$2,$3,'EMPTY_TREE','ADDED','README.md','blob','{}')",
  wip: "INSERT INTO history_wip_entries(repository_id,worktree_id,path,layer,revision_id,observed_at,data) VALUES($1,$2,'README.md','UNSTAGED',$3,now(),'{}')",
  cursor:
    "INSERT INTO history_cursors(repository_id,worktree_id,stream,data) VALUES($1,$2,'GIT_HISTORY','{}')",
  job: "INSERT INTO history_jobs(repository_id,id,kind,dedupe_key,data) VALUES($1,$2,'GIT_HISTORY','git-history:worktree:head','{}')",
};

it("upgrades an alpha.28 database to migration 7 without rewriting existing project data", async () => {
  // An alpha.28 installation: only migrations 1-6 have ever been applied.
  const db = await testDatabase({ through: 6 });
  const f = await fixture({ "src/refund.ts": "export const refund = () => 1;" });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    const app = new CodebaseService(c, db.store);
    const memory = await app.memory.remember({
      type: "DECISION",
      title: "Shared refunds",
      content: "Use the shared refund service.",
    });
    await app.memoryWorkflow.checkpoints.capture({
      memoryId: memory.id,
      implementation: "REPORTED_IMPLEMENTED",
      note: "Synthetic implementation report",
      links: [{ path: "src/refund.ts", role: "IMPLEMENTATION" }],
    });
    await app.memoryWorkflow.configure(true);
    const job = await app.memoryWorkflow.submit({
      sessionId: "upgrade-session",
      batchId: "upgrade-batch",
      messages: [{ id: "m1", role: "user", text: "İade akışları ortak servisi kullansın." }],
    });
    const historyTablesPresent = async () =>
      (
        await db.store.pool.query(
          "SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename=ANY($1::text[]) ORDER BY tablename",
          [historyTables],
        )
      ).rows.map((r) => r.tablename);
    const rows = async () =>
      (
        await db.store.pool.query(
          `SELECT 'repositories' AS source,id,xmin::text FROM repositories
          UNION ALL SELECT 'memories',id,xmin::text FROM memories
          UNION ALL SELECT 'memory_checkpoints',id,xmin::text FROM memory_checkpoints
          UNION ALL SELECT 'memory_jobs',id,xmin::text FROM memory_jobs
          UNION ALL SELECT 'memory_workflow_settings',repository_id,xmin::text FROM memory_workflow_settings
          ORDER BY 1,2`,
        )
      ).rows;
    expect((await db.store.diagnostics()).migrations).toEqual(
      [1, 2, 3, 4, 5, 6].map((version) => ({ version })),
    );
    expect(await historyTablesPresent()).toEqual([]);
    const before = await rows();
    expect(before).toHaveLength(5);
    // Servers never migrate at startup, so existing operations must not depend on migration 7.
    expect((await app.memoryWorkflow.recall({ task: "refund" })).results[0]?.id).toBe(memory.id);
    await db.store.migrate();
    await db.store.migrate();
    expect(await rows()).toEqual(before);
    expect((await db.store.diagnostics()).migrations).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((version) => ({ version })),
    );
    expect(await historyTablesPresent()).toEqual(historyTables);
    await expect(db.store.migrate(8)).rejects.toMatchObject({ code: "INVALID_ARGUMENT" });
    // Alpha.28 operations keep working against the upgraded schema.
    expect(
      (await app.memoryWorkflow.recall({ task: "refund", paths: ["src/refund.ts"] })).results[0],
    ).toMatchObject({ id: memory.id, checkpoint: { sourceState: "UNCHANGED" } });
    expect(await app.memoryWorkflow.list({ jobId: job.jobId })).toMatchObject({
      job: { state: "QUEUED" },
    });
    expect((await app.execute("search_memory", { query: "shared refund" })).results).toHaveLength(
      1,
    );
    expect(await app.memoryWorkflow.status()).toMatchObject({ enabled: true });
  } finally {
    await db.dispose();
    await f.dispose();
  }
});

it("keeps history evidence inside its project, retains it on clean and deletes it with the project", async () => {
  const db = await testDatabase();
  const a = await fixture({ "README.md": "# A" });
  const b = await fixture({ "README.md": "# B" });
  try {
    const ca = await createProjectContext(a.root);
    const cb = await createProjectContext(b.root);
    await db.store.register(ca);
    await db.store.register(cb);
    const A = ca.projectScopeId;
    const B = cb.projectScopeId;
    const q = (sql: string, values: unknown[]) => db.store.pool.query(sql, values);
    await q(insert.settings, [A]);
    await q(insert.worktree, [A, "worktree-a"]);
    await q(insert.revision, [A, "revision-a", "worktree-a"]);
    await q(insert.segment, [A, "revision-a", "segment-a"]);
    await q(insert.head, [A, "worktree-a", "revision-a"]);
    await q(insert.commit, [A, "commit-a"]);
    await q(insert.change, [A, "change-a", "commit-a"]);
    await q(insert.wip, [A, "worktree-a", "revision-a"]);
    await q(insert.cursor, [A, "worktree-a"]);
    await q(insert.job, [A, "job-1"]);
    expect(
      (
        await q(
          "SELECT git_history_enabled,policy_generation FROM history_settings WHERE repository_id=$1",
          [A],
        )
      ).rows,
    ).toEqual([{ git_history_enabled: false, policy_generation: 1 }]);

    // Project B cannot attach evidence to project A's worktree, revision or commit.
    const foreignKey = { code: "23503" };
    await q(insert.worktree, [B, "worktree-b"]);
    await expect(q(insert.revision, [B, "revision-b", "worktree-a"])).rejects.toMatchObject(
      foreignKey,
    );
    await expect(q(insert.segment, [B, "revision-a", "segment-b"])).rejects.toMatchObject(
      foreignKey,
    );
    await expect(q(insert.head, [B, "worktree-b", "revision-a"])).rejects.toMatchObject(foreignKey);
    await expect(q(insert.change, [B, "change-b", "commit-a"])).rejects.toMatchObject(foreignKey);
    await expect(q(insert.cursor, [B, "worktree-a"])).rejects.toMatchObject(foreignKey);

    // One active job per project deduplication key; finished jobs do not block new work.
    await expect(q(insert.job, [A, "job-2"])).rejects.toMatchObject({ code: "23505" });
    await q(insert.job, [B, "job-1"]);
    await q("UPDATE history_jobs SET state='SUCCEEDED' WHERE repository_id=$1 AND id=$2", [
      A,
      "job-1",
    ]);
    await q(insert.job, [A, "job-2"]);

    const counts = async (scope: string) => {
      const result: Record<string, number> = {};
      for (const table of historyTables)
        result[table] = (
          await q(`SELECT count(*)::int AS n FROM ${table} WHERE repository_id=$1`, [scope])
        ).rows[0].n;
      return result;
    };
    const seededA = await counts(A);
    const seededB = await counts(B);
    expect(
      Object.entries(seededA)
        .filter(([name]) => name !== "history_memory_evidence")
        .every(([, n]) => n > 0),
    ).toBe(true);
    // Like memory, history evidence survives clean; project removal deletes it.
    await db.store.clean(ca);
    expect(await counts(A)).toEqual(seededA);
    await db.store.clean(ca, true);
    expect(Object.values(await counts(A)).every((n) => n === 0)).toBe(true);
    expect(await counts(B)).toEqual(seededB);
  } finally {
    await db.dispose();
    await a.dispose();
    await b.dispose();
  }
});

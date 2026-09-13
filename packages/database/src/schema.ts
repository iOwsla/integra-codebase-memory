export const migration = `
CREATE EXTENSION IF NOT EXISTS vector;
CREATE EXTENSION IF NOT EXISTS pg_trgm;
CREATE TABLE repositories (id text PRIMARY KEY, root text NOT NULL UNIQUE, name text NOT NULL, version integer NOT NULL DEFAULT 0, fingerprint text NOT NULL DEFAULT '', indexed_at timestamptz, created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE files (repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE, id text NOT NULL, path text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(repository_id,id), UNIQUE(repository_id,path));
CREATE TABLE symbols (repository_id text NOT NULL, id text NOT NULL, file_id text NOT NULL, name text NOT NULL, qualified_name text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(repository_id,id), FOREIGN KEY(repository_id,file_id) REFERENCES files(repository_id,id) ON DELETE CASCADE);
CREATE INDEX symbols_name ON symbols(repository_id,name);
CREATE INDEX symbols_qualified ON symbols(repository_id,qualified_name);
CREATE INDEX symbols_file ON symbols(repository_id,file_id);
CREATE INDEX symbols_fuzzy ON symbols USING gin(name gin_trgm_ops);
CREATE TABLE symbol_edges (repository_id text NOT NULL, id text NOT NULL, source_id text NOT NULL,target_id text NOT NULL,file_id text NOT NULL,edge_type text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(repository_id,id),FOREIGN KEY(repository_id,source_id) REFERENCES symbols(repository_id,id) ON DELETE CASCADE,FOREIGN KEY(repository_id,target_id) REFERENCES symbols(repository_id,id) ON DELETE CASCADE);
CREATE INDEX edges_in ON symbol_edges(repository_id,target_id);
CREATE INDEX edges_out ON symbol_edges(repository_id,source_id);
CREATE INDEX edges_type ON symbol_edges(repository_id,edge_type);
CREATE TABLE unresolved_references (repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,id text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(repository_id,id));
CREATE TABLE memories (repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,id text NOT NULL,data jsonb NOT NULL,PRIMARY KEY(repository_id,id));
CREATE INDEX memories_search ON memories USING gin(to_tsvector('simple',data->>'content'));
CREATE TABLE index_runs (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE index_errors (id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,message text NOT NULL,created_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE settings (repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,key text NOT NULL,value jsonb NOT NULL,PRIMARY KEY(repository_id,key));
`;

// Additive query indexes; migration 1 remains immutable for existing installations.
export const migrations = [
  migration,
  `
CREATE INDEX symbols_name_lower ON symbols USING gin(lower(name) gin_trgm_ops);
CREATE INDEX symbols_qualified_lower ON symbols(repository_id,lower(qualified_name));
CREATE INDEX files_content_lower ON files USING gin(lower(data->>'content') gin_trgm_ops) WHERE data->>'status'='INDEXED';
CREATE INDEX files_incomplete ON files(repository_id) WHERE data->>'status'<>'INDEXED';
CREATE INDEX index_runs_project_latest ON index_runs(repository_id,id DESC);
CREATE INDEX edges_in_page ON symbol_edges(repository_id,target_id,edge_type,source_id);
CREATE INDEX edges_out_page ON symbol_edges(repository_id,source_id,edge_type,target_id);
`,
  `
CREATE INDEX memories_page ON memories(repository_id,(data->>'createdAt') DESC,id);
CREATE INDEX memories_type_status ON memories(repository_id,(data->>'type'),(data->>'status'));
CREATE INDEX memories_scope ON memories(repository_id,(data#>>'{scope,type}'),(data#>>'{scope,target}'));
CREATE INDEX memories_tags ON memories USING gin((data->'tags'));
`,
  `CREATE TABLE index_jobs(repository_id text PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE, backend_pid integer NOT NULL, data jsonb NOT NULL);`,
  `
CREATE TABLE memory_workflow_settings(repository_id text PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE, enabled boolean NOT NULL DEFAULT false);
CREATE TABLE memory_jobs(repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,id text NOT NULL,session_id text NOT NULL,batch_id text NOT NULL,input_hash text NOT NULL,state text NOT NULL DEFAULT 'QUEUED',data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT now(),PRIMARY KEY(repository_id,id),UNIQUE(repository_id,session_id,batch_id));
CREATE INDEX memory_jobs_queue ON memory_jobs(repository_id,state,created_at,id);
CREATE INDEX memories_recall_content ON memories USING gin(to_tsvector('simple',(data->>'title') || ' ' || (data->>'content')));
`,
  `CREATE TABLE memory_checkpoints (
repository_id text NOT NULL, memory_id text NOT NULL, id text NOT NULL,
created_at timestamptz NOT NULL, data jsonb NOT NULL,
PRIMARY KEY(repository_id,id),
FOREIGN KEY(repository_id,memory_id) REFERENCES memories(repository_id,id) ON DELETE CASCADE);
CREATE INDEX memory_checkpoints_latest ON memory_checkpoints(repository_id,memory_id,created_at DESC,id DESC);`,
  // Document and Git history evidence. Unpublished draft until its first release; additive only.
  // Composite project keys keep revisions, segments, commits and jobs inside one project scope.
  `CREATE TABLE history_settings(
repository_id text PRIMARY KEY REFERENCES repositories(id) ON DELETE CASCADE,
documents_enabled boolean NOT NULL DEFAULT false, git_history_enabled boolean NOT NULL DEFAULT false,
policy_generation integer NOT NULL DEFAULT 1, policy jsonb NOT NULL DEFAULT '{}'::jsonb,
updated_at timestamptz NOT NULL DEFAULT now());
CREATE TABLE history_worktrees(
repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
id text NOT NULL, kind text NOT NULL, data jsonb NOT NULL, PRIMARY KEY(repository_id,id));
CREATE TABLE history_revisions(
repository_id text NOT NULL, id text NOT NULL, worktree_id text NOT NULL,
source_kind text NOT NULL, origin text NOT NULL, path text NOT NULL, object_id text,
content_hash text NOT NULL, captured_at timestamptz NOT NULL DEFAULT now(), data jsonb NOT NULL,
PRIMARY KEY(repository_id,id),
FOREIGN KEY(repository_id,worktree_id) REFERENCES history_worktrees(repository_id,id) ON DELETE CASCADE);
CREATE INDEX history_revisions_path ON history_revisions(repository_id,worktree_id,path,captured_at DESC);
CREATE TABLE history_segments(
repository_id text NOT NULL, revision_id text NOT NULL, segmenter text NOT NULL, ordinal integer NOT NULL,
id text NOT NULL, kind text NOT NULL, start_line integer NOT NULL, end_line integer NOT NULL,
start_byte integer NOT NULL, end_byte integer NOT NULL, content_hash text NOT NULL, excerpt text,
data jsonb NOT NULL, PRIMARY KEY(repository_id,revision_id,segmenter,ordinal), UNIQUE(repository_id,id),
FOREIGN KEY(repository_id,revision_id) REFERENCES history_revisions(repository_id,id) ON DELETE CASCADE);
CREATE INDEX history_segments_content ON history_segments(repository_id,content_hash);
CREATE INDEX history_segments_search ON history_segments USING gin(to_tsvector('simple',coalesce(excerpt,'')));
CREATE TABLE history_memory_evidence(
repository_id text NOT NULL,memory_id text NOT NULL,segment_id text NOT NULL,
PRIMARY KEY(repository_id,memory_id,segment_id),
FOREIGN KEY(repository_id,memory_id) REFERENCES memories(repository_id,id) ON DELETE CASCADE,
FOREIGN KEY(repository_id,segment_id) REFERENCES history_segments(repository_id,id));
CREATE TABLE history_document_heads(
repository_id text NOT NULL, worktree_id text NOT NULL, path text NOT NULL, state text NOT NULL,
revision_id text, previous_revision_id text, observed_at timestamptz NOT NULL DEFAULT now(),
PRIMARY KEY(repository_id,worktree_id,path),
FOREIGN KEY(repository_id,worktree_id) REFERENCES history_worktrees(repository_id,id) ON DELETE CASCADE,
FOREIGN KEY(repository_id,revision_id) REFERENCES history_revisions(repository_id,id),
FOREIGN KEY(repository_id,previous_revision_id) REFERENCES history_revisions(repository_id,id));
CREATE TABLE history_wip_entries(
repository_id text NOT NULL,worktree_id text NOT NULL,path text NOT NULL,layer text NOT NULL,
revision_id text,state text NOT NULL DEFAULT 'ACTIVE',observed_at timestamptz NOT NULL,data jsonb NOT NULL,
PRIMARY KEY(repository_id,worktree_id,path,layer),
FOREIGN KEY(repository_id,worktree_id) REFERENCES history_worktrees(repository_id,id) ON DELETE CASCADE,
FOREIGN KEY(repository_id,revision_id) REFERENCES history_revisions(repository_id,id));
CREATE TABLE history_commits(
repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
object_id text NOT NULL, object_format text NOT NULL, tree_id text NOT NULL, parent_ids text[] NOT NULL,
committed_at timestamptz, data jsonb NOT NULL, PRIMARY KEY(repository_id,object_id));
CREATE TABLE history_file_changes(
repository_id text NOT NULL, id text NOT NULL, commit_id text NOT NULL, comparison_parent text NOT NULL,
change_kind text NOT NULL, old_path text, new_path text, old_object_id text, new_object_id text,
data jsonb NOT NULL, PRIMARY KEY(repository_id,id),
FOREIGN KEY(repository_id,commit_id) REFERENCES history_commits(repository_id,object_id) ON DELETE CASCADE);
CREATE INDEX history_file_changes_search ON history_file_changes USING gin(to_tsvector('simple',coalesce(new_path,'') || ' ' || coalesce(old_path,'') || ' ' || data::text));
CREATE INDEX history_file_changes_commit ON history_file_changes(repository_id,commit_id,comparison_parent);
CREATE INDEX history_file_changes_new_path ON history_file_changes(repository_id,new_path) WHERE new_path IS NOT NULL;
CREATE INDEX history_file_changes_old_path ON history_file_changes(repository_id,old_path) WHERE old_path IS NOT NULL;
CREATE TABLE history_jobs(
repository_id text NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
id text NOT NULL, kind text NOT NULL, dedupe_key text NOT NULL, state text NOT NULL DEFAULT 'QUEUED',
attempts integer NOT NULL DEFAULT 0, lease_token text, lease_expires_at timestamptz,
created_at timestamptz NOT NULL DEFAULT now(), updated_at timestamptz NOT NULL DEFAULT now(),
data jsonb NOT NULL, PRIMARY KEY(repository_id,id));
CREATE UNIQUE INDEX history_jobs_active ON history_jobs(repository_id,dedupe_key) WHERE state IN ('QUEUED','RUNNING');
CREATE INDEX history_jobs_queue ON history_jobs(repository_id,state,created_at,id);
CREATE TABLE history_cursors(
repository_id text NOT NULL, worktree_id text NOT NULL, stream text NOT NULL, data jsonb NOT NULL,
updated_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(repository_id,worktree_id,stream),
FOREIGN KEY(repository_id,worktree_id) REFERENCES history_worktrees(repository_id,id) ON DELETE CASCADE);`,
];

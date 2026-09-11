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
];

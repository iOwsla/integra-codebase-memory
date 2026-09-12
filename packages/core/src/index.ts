import type { MemoryWorkflowStore } from "./memory-workflow";

export type {
  MemoryBatch,
  MemoryCandidate,
  MemoryJob,
  MemoryWorkflowStore,
} from "./memory-workflow";
export type SymbolKind =
  | "FILE"
  | "MODEL"
  | "FIELD"
  | "MODULE"
  | "FUNCTION"
  | "METHOD"
  | "CLASS"
  | "INTERFACE"
  | "TYPE_ALIAS"
  | "ENUM"
  | "VARIABLE"
  | "CONSTANT"
  | "PROPERTY"
  | "CONSTRUCTOR"
  | "IMPORT"
  | "EXPORT";
export type Resolution = "AST_CONFIRMED" | "SEMANTIC_CONFIRMED" | "HEURISTIC" | "UNRESOLVED";
export interface EffectiveConfig {
  readonly maxFileSizeBytes: number;
  readonly parserTimeoutMs: number;
  readonly parserOutputLimitMiB: number;
  readonly exclude: readonly string[];
  readonly include: readonly string[];
  readonly excludeGenerated: boolean;
  readonly debounceMs: number;
  readonly reconcileMs: number;
}
export interface ProjectContext {
  readonly sessionId: string;
  readonly projectScopeId: string;
  readonly canonicalRoot: string;
  readonly effectiveConfig: EffectiveConfig;
  readonly indexVersion: string;
}
export interface IndexedFile {
  id: string;
  path: string;
  language: string;
  hash: string;
  size: number;
  modifiedAt: string;
  generated: boolean;
  status: "INDEXED" | "SKIPPED_TOO_LARGE" | "SKIPPED_BINARY" | "INDEX_ERROR";
  content: string;
  parserVersion: string;
  error?: string;
}
export interface CodeSymbol {
  id: string;
  fileId: string;
  file: string;
  kind: SymbolKind;
  name: string;
  qualifiedName: string;
  startLine: number;
  startColumn: number;
  endLine: number;
  endColumn: number;
  signature: string;
  exported: boolean;
  async: boolean;
  static: boolean;
  visibility: string;
  contentHash: string;
  metadata: Record<string, unknown>;
}
export interface SymbolEdge {
  metadata?: Record<string, unknown>;
  id: string;
  source: string;
  target: string;
  type: string;
  confidence: number;
  resolution: Resolution;
  fileId: string;
  line: number;
}
export interface UnresolvedReference {
  id: string;
  source: string;
  fileId: string;
  line: number;
  expression: string;
  reason: string;
  type: string;
}
export interface Analysis {
  symbols: CodeSymbol[];
  edges: SymbolEdge[];
  unresolved: UnresolvedReference[];
  diagnostics: {
    file: string;
    message: string;
    kind?: "SYNTAX_ERROR" | "CONFIGURATION";
    line?: number;
    column?: number;
    code?: number;
  }[];
}
export interface Snapshot extends Analysis {
  files: IndexedFile[];
  version: number;
  fingerprint: string;
  indexedAt: string | null;
}
export interface IndexState {
  files: Pick<IndexedFile, "path" | "hash" | "status">[];
  version: number;
  fingerprint: string;
  indexedAt: string | null;
}
export type MemoryType =
  | "FACT"
  | "DECISION"
  | "WARNING"
  | "NOTE"
  | "CONVENTION"
  | "INCIDENT"
  | "TODO";
export interface MemoryEntry {
  id: string;
  type: MemoryType;
  title: string;
  content: string;
  scope: { type: "repository" | "directory" | "file" | "symbol"; target?: string };
  tags: string[];
  priority: number;
  status: "ACTIVE" | "SUPERSEDED" | "ARCHIVED";
  source: string;
  createdAt: string;
  updatedAt: string;
  supersededBy?: string;
}
export interface MemorySearch {
  query: string;
  types: MemoryType[];
  tags: string[];
  scope?: MemoryEntry["scope"];
  /** Canonical and legacy spellings, supplied by the scoped application service. */
  scopeTargets?: string[];
  includeInactive: boolean;
  limit: number;
  offset: number;
}
export interface ExclusionSummary {
  files: number;
  directories: number;
  other: number;
  byReason: Record<string, { files: number; directories: number; other: number }>;
}
export interface StatusOptions {
  diagnosticLimit?: number;
  diagnosticOffset?: number;
}
export interface IndexResult {
  version: number;
  changed: number;
  deleted: number;
  excluded: number;
  exclusions?: ExclusionSummary;
  reason: string;
  indexedAt: string | null;
}
export interface IndexProgress {
  state: "RUNNING" | "SUCCEEDED" | "FAILED";
  stage: "SCANNING" | "ANALYZING" | "PUBLISHING" | "COMPLETE";
  startedAt: string;
  updatedAt: string;
  error?: string;
  version?: number;
}
export interface IndexMetadata {
  indexVersion: number;
  indexedAt: string | null;
  freshness: "LAST_COMPLETED" | "UPDATING";
  staleSince?: string;
  incomplete: boolean;
}
export interface PageRequest {
  limit: number;
  offset: number;
}
export interface SymbolSelector {
  symbolId?: string;
  name?: string;
}
/** Scoped, bounded reads from one completed generation. Valid only inside readIndex. */
export interface IndexReader {
  deadCodeCandidates(page: PageRequest): Promise<Record<string, unknown>>;
  duplicateCode(minBodyLength: number, page: PageRequest): Promise<Record<string, unknown>>;
  searchSymbols(
    query: string,
    kinds: string[],
    page: PageRequest,
  ): Promise<Record<string, unknown>>;
  searchCode(query: string, page: PageRequest): Promise<Record<string, unknown>>;
  symbol(selector: SymbolSelector): Promise<Record<string, unknown>>;
  relationships(
    selector: SymbolSelector,
    direction: "incoming" | "outgoing",
    type: string,
    page: PageRequest,
  ): Promise<Record<string, unknown>>;
  trace(
    from: string,
    direction: "incoming" | "outgoing",
    maxDepth: number,
    maxPaths: number,
    types: string[],
  ): Promise<Record<string, unknown>>;
  outline(path: string, page: PageRequest): Promise<Record<string, unknown>>;
  context(
    path: string,
    line: number,
    before: number,
    after: number,
  ): Promise<Record<string, unknown>>;
}
export interface ProjectStore extends MemoryWorkflowStore {
  recordIndexProgress(context: ProjectContext, progress: IndexProgress): Promise<void>;
  register(context: ProjectContext): Promise<void>;
  snapshot(context: ProjectContext): Promise<Snapshot>;
  indexState(context: ProjectContext): Promise<IndexState>;
  readIndex<T>(
    context: ProjectContext,
    action: (reader: IndexReader, metadata: IndexMetadata) => Promise<T>,
  ): Promise<T>;
  locked<T>(context: ProjectContext, action: (store: ProjectStore) => Promise<T>): Promise<T>;
  publish(
    context: ProjectContext,
    snapshot: Snapshot,
    changed: string[],
    deleted: string[],
    run: IndexResult,
  ): Promise<void>;
  recordFailure(context: ProjectContext, message: string): Promise<void>;
  status(context: ProjectContext, options?: StatusOptions): Promise<Record<string, unknown>>;
  saveMemory(context: ProjectContext, memory: MemoryEntry, supersedes?: string): Promise<void>;
  memories(context: ProjectContext): Promise<MemoryEntry[]>;
  searchMemories(
    context: ProjectContext,
    query: MemorySearch,
  ): Promise<{ results: MemoryEntry[]; hasMore: boolean; nextOffset: number }>;
  archiveMemory(context: ProjectContext, id: string): Promise<boolean>;
  clean(context: ProjectContext, remove?: boolean): Promise<void>;
  diagnostics(): Promise<Record<string, unknown>>;
  close(): Promise<void>;
}
export type ConfigurationReferences = (path: string, text: string) => string[];
export interface LanguagePlugin {
  readonly configurationReferences?: ConfigurationReferences;
  readonly id: string;
  readonly version: string;
  readonly extensions: readonly string[];
  analyze(
    context: ProjectContext,
    files: IndexedFile[],
    configs: Map<string, string>,
  ): Promise<Analysis>;
}
export interface FrameworkPlugin {
  readonly id: string;
  augment(context: ProjectContext, analysis: Analysis): Promise<Analysis>;
}
export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}
export interface FileHasher {
  hash(content: Uint8Array | string): string;
}
export interface FileScanner {
  scan(
    context: ProjectContext,
    references?: ConfigurationReferences,
  ): Promise<{
    files: IndexedFile[];
    configs: Map<string, string>;
    excluded: number;
    exclusions?: ExclusionSummary;
  }>;
}
export interface GitProvider {
  inspect(root: string): Promise<{ branch: string | null; head: string | null }>;
}
export class CodeMemoryError extends Error {
  constructor(
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "CodeMemoryError";
  }
}

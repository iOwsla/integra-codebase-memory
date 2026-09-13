import type { MemoryEntry } from "./index";
export type HistoryData = Record<string, unknown>;
export interface HistorySettings {
  documents: boolean;
  git: boolean;
  wip: boolean;
  providers: boolean;
  automatic: boolean;
  policyGeneration: number;
  maxFileBytes: number;
  maxStorageBytes: number;
  retentionDays: number;
}
export interface HistoryRevision {
  id: string;
  worktreeId: string;
  sourceKind: string;
  origin: string;
  path: string;
  objectId?: string;
  contentHash: string;
  data: HistoryData;
}
export interface HistorySegment {
  id: string;
  ordinal: number;
  kind: string;
  startLine: number;
  endLine: number;
  startByte: number;
  endByte: number;
  contentHash: string;
  excerpt: string;
  headingPath: { text: string; depth: number; occurrence: number }[];
}
export interface HistoryCommit {
  id: string;
  objectFormat: string;
  tree: string;
  parents: string[];
  committedAt: string;
  data: HistoryData;
}
export interface HistoryChange {
  id: string;
  commitId: string;
  parent: string;
  kind: string;
  oldPath: string | null;
  newPath: string | null;
  oldObjectId: string | null;
  newObjectId: string | null;
  data: HistoryData;
}
export interface HistoryJob {
  id: string;
  kind: "COLLECT" | "INTERPRET";
  state: string;
  data: HistoryData;
  createdAt?: string;
  attempts?: number;
}
export interface HistoryPage {
  results: HistoryData[];
  hasMore: boolean;
  nextOffset: number | null;
}
export interface HistoryStore {
  writeBackup(write: (record: HistoryBackupRecord) => Promise<void>): Promise<void>;
  restoreBackup(records: AsyncIterable<HistoryBackupRecord>): Promise<number>;
  settings(): Promise<HistorySettings>;
  configure(value: HistorySettings): Promise<void>;
  worktree(id: string, kind: string, data: HistoryData): Promise<void>;
  getRevision(id: string): Promise<HistoryRevision | undefined>;
  nextJob(providers: boolean): Promise<HistoryJob | undefined>;
  revision(value: HistoryRevision, segments: HistorySegment[]): Promise<void>;
  documentHead(worktree: string, path: string, revision: string, scan: string): Promise<void>;
  reconcileDocuments(worktree: string, scan: string): Promise<void>;
  wipEntry(
    worktree: string,
    path: string,
    layer: string,
    revision: string | null,
    scan: string,
    data: HistoryData,
  ): Promise<void>;
  reconcileWip(worktree: string, scan: string): Promise<void>;
  commit(value: HistoryCommit): Promise<void>;
  change(value: HistoryChange): Promise<void>;
  cursor(worktree: string, stream: string, data?: HistoryData): Promise<HistoryData | undefined>;
  enqueue(job: HistoryJob, dedupe: string): Promise<string>;
  job(id: string): Promise<HistoryJob | undefined>;
  saveJob(job: HistoryJob): Promise<void>;
  runExclusive<T>(
    action: (store: HistoryStore, leaseSignal: AbortSignal) => Promise<T>,
  ): Promise<T>;
  runModelExclusive<T>(action: (leaseSignal: AbortSignal) => Promise<T>): Promise<T>;
  list(
    kind: "documents" | "changes" | "jobs" | "segments" | "wip" | "intent",
    query: string,
    path: string,
    limit: number,
    offset: number,
    revision?: string,
  ): Promise<HistoryPage>;
  evidence(ids: string[]): Promise<HistoryData[]>;
  memoryEvidence(ids: string[]): Promise<HistoryData[]>;
  stats(): Promise<HistoryData>;
  promote(
    jobId: string,
    candidateId: string,
    memory: MemoryEntry,
    userApproval: string,
    supersedes?: string,
  ): Promise<string>;
  cleanup(days: number, purge: boolean, apply: boolean): Promise<HistoryData>;
}

export const defaultHistorySettings: HistorySettings = {
  documents: false,
  git: false,
  wip: false,
  providers: false,
  automatic: false,
  policyGeneration: 1,
  maxFileBytes: 2097152,
  maxStorageBytes: 268435456,
  retentionDays: 30,
};

export interface HistoryBackupRecord {
  table: string;
  row: HistoryData;
}

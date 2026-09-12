import type { MemoryEntry, ProjectContext } from "./index";

export interface MemoryBatch {
  sessionId: string;
  batchId: string;
  messages: { id: string; role: "user" | "assistant"; text: string }[];
}
export interface MemoryCandidate {
  id: string;
  claim: string;
  classification: string;
  evidence: { messageId: string; quote: string }[];
  verdict: string;
  reasonCode: string;
  reason: string;
  state: "READY" | "NEEDS_REVIEW" | "REJECTED" | "PROMOTED";
  memoryId?: string;
  review?: { action: "APPROVE" | "REJECT"; userApproval: string; reviewedAt: string };
}
export interface MemoryJob {
  id: string;
  state: "QUEUED" | "RUNNING" | "SUCCEEDED" | "FAILED";
  input: MemoryBatch;
  candidates: MemoryCandidate[];
  attempts: number;
  createdAt: string;
  error?: string;
  errorMessage?: string;
  phase?: string;
  owner?: { pid: number; sessionId: string; startedAt: string };
  diagnosticId?: string;
  metrics?: Record<string, unknown>;
}
export interface MemoryWorkflowStore {
  saveMemoryCheckpoint(c: ProjectContext, checkpoint: MemoryCheckpoint): Promise<void>;
  memoryCheckpoints(
    c: ProjectContext,
    memoryId: string,
    limit: number,
    offset: number,
  ): Promise<MemoryCheckpoint[]>;

  memoryWorkflowEnabled(c: ProjectContext): Promise<boolean>;
  configureMemoryWorkflow(c: ProjectContext, enabled: boolean): Promise<void>;
  enqueueMemory(
    c: ProjectContext,
    input: MemoryBatch,
  ): Promise<{ job: MemoryJob; duplicate: boolean }>;
  memoryJobs(
    c: ProjectContext,
    limit: number,
    offset: number,
  ): Promise<{ results: MemoryJob[]; hasMore: boolean; nextOffset: number }>;
  memoryJob(c: ProjectContext, id: string): Promise<MemoryJob>;
  retryMemoryJob(c: ProjectContext, id: string): Promise<void>;
  workMemory(
    c: ProjectContext,
    run: (
      job: MemoryJob,
      progress: (phase: string, metrics?: Record<string, unknown>) => Promise<void>,
      leaseSignal: AbortSignal,
    ) => Promise<Pick<MemoryJob, "candidates" | "metrics">>,
  ): Promise<boolean>;
  reviewMemory(
    c: ProjectContext,
    jobId: string,
    candidateId: string,
    approval: string,
    reject: boolean,
    supersedes?: string,
  ): Promise<{ candidate: MemoryCandidate; memory?: MemoryEntry }>;
  recallMemories(
    c: ProjectContext,
    query: string,
    paths: string[],
    symbols: string[],
    limit: number,
  ): Promise<{ results: MemoryEntry[]; hasMore: boolean }>;
}

/** Immutable source observation; implementation and test claims remain explicitly reported. */
export interface MemoryCheckpoint {
  id: string;
  memoryId: string;
  createdAt: string;
  implementation: "REQUESTED" | "REPORTED_IMPLEMENTED";
  note: string;
  links: {
    path: string;
    role: "IMPLEMENTATION" | "CALLER" | "PRISMA_MODEL" | "TEST";
    locator?: string;
    contentHash: string;
  }[];
  verification: "NOT_RUN" | "REPORTED_PASS" | "REPORTED_FAIL";
  verificationNote: string;
}

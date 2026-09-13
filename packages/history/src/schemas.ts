import { z } from "zod";

const page = {
  limit: z.number().int().min(1).max(20).default(10),
  offset: z.number().int().min(0).max(1000000).default(0),
};
export const historyReadSchemas = {
  history_status: z.object({}).strict(),
  get_history_job: z
    .object({
      jobId: z.string().min(1).max(100),
      limit: z.number().int().min(1).max(5).default(1),
      offset: z.number().int().min(0).max(100).default(0),
    })
    .strict(),
  search_history: z
    .object({
      kind: z
        .enum(["documents", "changes", "jobs", "segments", "wip", "intent"])
        .default("changes"),
      query: z.string().max(500).default(""),
      path: z.string().max(1000).default(""),
      revisionId: z.string().max(100).optional(),
      ...page,
    })
    .strict(),
  get_history_evidence: z
    .object({ ids: z.array(z.string().min(1).max(100)).min(1).max(10) })
    .strict(),
  engineering_context: z
    .object({
      task: z.string().max(500).default(""),
      paths: z.array(z.string().max(1000)).max(5).default([]),
      ...page,
    })
    .strict(),
};
export const configureHistorySchema = z
  .object({
    documents: z.boolean().optional(),
    git: z.boolean().optional(),
    wip: z.boolean().optional(),
    providers: z.boolean().optional(),
    automatic: z.boolean().optional(),
    maxFileBytes: z.number().int().min(1024).max(2097152).optional(),
    maxStorageBytes: z.number().int().min(1048576).max(1073741824).optional(),
    retentionDays: z.number().int().min(1).max(365).optional(),
    apply: z.boolean().default(false),
  })
  .strict();
export const historyWriteSchemas = {
  collect_history: z
    .object({
      jobId: z.string().max(100).optional(),
      batchSize: z.number().int().min(1).max(100).default(20),
    })
    .strict(),
  submit_history_candidates: z
    .object({
      evidenceIds: z.array(z.string().max(100)).min(1).max(10),
      batchId: z.string().min(1).max(100),
    })
    .strict(),
  review_history_candidate: z
    .object({
      jobId: z.string().max(100),
      candidateId: z.string().max(100),
      action: z.enum(["APPROVE", "REJECT"]),
      userApproval: z.string().min(5).max(500),
      supersedes: z.string().max(100).optional(),
    })
    .strict(),
};

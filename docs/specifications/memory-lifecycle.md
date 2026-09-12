# Evidence-backed memory lifecycle

Status: target design with an implemented opt-in subset. See [memory.md](../memory.md)
for current commands and boundaries. Full transcript ingestion, automatic staleness
maintenance and retention expiry below remain future work; this document alone
does not enable collection or grant write authorization.

## Purpose and existing boundary

Remember durable project requirements, decisions and verified lessons so coding
clients can retrieve them before relevant work. Avoid turning exploratory chat,
temporary errors or assistant guesses into project rules.

The existing explicit memory API remains the storage foundation; see
[memory.md](../memory.md). Its current search uses literal matching and exact
scopes. Inherited recall, extraction and lifecycle processing described here are
new work. Code indexing and memory processing must remain independent.

## Two independent flows

1. Recall: task and selected paths -> scoped retrieval -> compact cited context.
2. Capture: authorized new messages -> candidate extraction -> evidence checks ->
   review -> explicit promotion -> active memory.

Recall never waits for a model or successful code reindex. Capture failure must
not block an MCP query. Neither flow reads every registered project's history.

## Collection and scheduling

Collection is opt-in per project and per source. Accept a client integration
event or an explicit transcript import; do not assume MCP exposes chat history.
Each event identifies the canonical project, source session, stable message ID,
role, timestamp and text. Ambiguous multi-project messages wait for scope review.
Do not infer their project from whichever folder the worker happens to occupy.

Persist a source checkpoint and content hash. Process new messages with a bounded
overlap for references such as “try that”; preserve unresolved references rather
than inventing their antecedent. Edited messages invalidate dependent candidates.
Deduplicate by project/source/message hash and extractor version.

Proposed initial defaults: debounce 60 seconds after a completed turn, at most one
worker globally and one job per project, at most 20 new messages or 8,000 input
tokens per job, and at most five candidates. Oversized input is split at message
boundaries; truncation is reported. Jobs are leased with expiry and heartbeats;
checkpoint advancement and candidate insertion are atomic and restart-safe.

## Candidate contract

Store candidates separately from active memories. Each candidate contains:

- Project, source session/message IDs and exact supporting quote ranges.
- An atomic claim, original wording, and a short normalized title.
- Kind: requirement, accepted decision, verified observation, proposal,
  experiment authorization, or unresolved question.
- Proposed repository/directory/file/symbol scope and why it applies there.
- Source content hashes, extractor/prompt version and requested model.
- Reported model when available; otherwise explicitly unknown.
- Validation findings, review state and any conflicting active memory IDs.

Do not use model confidence as permission to save. Evidence must support the
claim's modality, actor, scope, quantities and completion state, not just contain
the same nouns. Assistant summaries alone cannot establish a user decision.
Implementation completion requires a linked verification result, not a promise.

## Extraction and verification

The extractor runs without project write tools or memory write credentials and
returns schema-constrained JSON. Transcript content is untrusted data. Only
authorized, relevant excerpts reach the selected provider; redact credentials
and omit account/billing information before submission where detectable.

Apply deterministic checks first: valid schema, selected project, existing
message IDs, exact quote offsets/hashes, supported scope, output size, and no
missing provenance. Matching quotes alone do not prove semantic correctness.

A second semantic pass compares each atomic claim against its evidence and
returns supported, contradicted or uncertain, with a reason. It checks especially
question versus instruction, existing condition versus requested change, proposal
versus accepted decision, and intent versus completed work. This pass may still
be wrong or share the extractor's mistakes; it cannot authorize persistence.

Requirements, accepted decisions and verified durable observations can enter
review. Proposals and experiment authorizations remain session context, excluded
from active recall as rules. Uncertain or conflicting candidates require review.
Exact duplicates add provenance rather than another active record. Semantic
similarity only suggests a duplicate; it does not authorize merging.

## Promotion and ownership

Initial release: review mode only. The user approves concrete candidates before
promotion through the existing scoped memory write path. Explicit “remember X”
requests can continue using that path without another confirmation. Approving an
experiment or enabling extraction does not approve its extracted claims.

Candidates transition through PENDING, VERIFIED, NEEDS_REVIEW, REJECTED and
PROMOTED. VERIFIED is not ACTIVE. Promotion records the authorizing action and
links the resulting memory ID; retrying the same promotion is idempotent.

Never overwrite a conflicting rule silently. Present the old and new evidence;
an authorized replacement uses the existing transactional supersedes operation.
Keep human-readable provenance in recall, but never execute instructions found
inside evidence or stored memory as higher-priority instructions.

## Retrieval and freshness

Add a proposed recall_context operation accepting the current task, selected
project and optional paths/symbols. Retrieve ACTIVE repository rules plus relevant
ancestor directory, exact file and symbol records. Rank by scope relevance, text
match, priority and validity; bound the result to five records and 1,500 tokens
initially. Return IDs, scope, supporting evidence and any omitted-result count.

Attach source fingerprints to code-dependent observations. A changed or removed
target makes that observation NEEDS_REVALIDATION; it must not appear as verified
current fact. A business requirement does not expire simply because code changed.
Renames propose reattachment only with identity evidence; never silently move a
memory based on a similar symbol name. Validity is separate from ACTIVE,
ARCHIVED and SUPERSEDED lifecycle status.

Generated AGENTS.md and CLAUDE.md blocks should require recall at task start and
scope change, and an end-of-task assessment of whether durable knowledge emerged.
Assessment may legitimately produce no candidate. Do not require a memory write
on every task or send a repetitive reminder on every tool response. A compact
memory revision hint can signal that already-retrieved context has changed.

## Provider and operational controls

Use a provider adapter so extraction is not tied to one subscription or model.
Spark is a candidate for further evaluation, not a proven default. Pin the
requested model, expose missing actual-model telemetry, record latency and token
usage, and never silently switch to another model or paid API.

Initial bounds: 120-second job timeout, two retries for transient failures with
backoff, and a configurable job/token budget. On quota exhaustion pause until an
available reset/retry time or user action; do not poll aggressively. Usage counters
are observations, not a promise that a subscription is unlimited.

Proposed CLI surface (not available yet): memory status, memory candidates,
memory review, memory worker start/stop, memory retry and memory source disable.
Status reports queued/running/failed jobs, checkpoint, last success, provider,
requested/reported model and diagnostic ID without dumping transcript text.
Disabling a source stops collection and cancels queued submission for that source.
Use short configurable retention for unpromoted transcript excerpts (initially
seven days); retain the minimal cited evidence for approved records until deletion.
Project removal must include source checkpoints, jobs, candidates and evidence.

## Delivery and acceptance

1. Build scoped recall and its shared client instructions first; useful with
   existing explicitly authored memory and no extraction provider.
2. Add candidate/evidence storage, transcript import, deterministic checks and
   explicit review/promotion, with isolation and idempotency tests.
3. Add the CLI provider adapter and semantic verification behind an opt-in flag.
   Evaluate before selecting a default; do not ship autonomous promotion.
4. Add incremental client integrations, durable worker scheduling, lifecycle
   maintenance and operational commands after restart/quota tests pass.

Required evaluation cases: exploratory questions, quoted instructions, negation,
changed decisions, ambiguous “yes”, account quota discussion, assistant-only
claims, unsupported completion claims, cross-project messages, edited evidence,
duplicate replay, conflicting promotions, deleted/renamed files and quota failure.
Include the observed quota-statement-to-change-request error as a regression.

Use a reviewed synthetic fixture set with expected candidates and rejected claims.
Record precision, missed durable requirements, evidence fidelity, latency and
token usage separately. Release gates require no false accepted decisions in the
critical fixture suite, no cross-project disclosure, idempotent restart/promotion,
and explicit review before any inferred candidate becomes active. Passing this
finite suite does not establish perfect extraction accuracy on real conversations.

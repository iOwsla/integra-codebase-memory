# Developing the memory workflow

The authoritative runtime contract is `packages/memory/src/protocol.ts`. English
prompts, schema enums and host-enforced invariants evolve together. Documentation
is guidance; model output and stored evidence are never executable instructions.

## Change discipline

1. Reproduce a reported failure using a minimal synthetic fixture. Preserve intent,
   negation and ambiguity, but never commit private transcripts or credentials.
2. Define the expected candidate and rejection behavior before changing prompts.
   Track missed requirements as well as false accepted decisions.
3. Change extraction and verification separately where possible. Preserve exact
   message IDs and quotes; do not repair a hallucinated field or quote silently.
4. Increment the protocol version for semantic/schema changes. Existing queued
   messages use the installed protocol when processed; completed jobs retain their
   recorded version and evidence. Never reinterpret an approved record silently.
5. Run deterministic service tests and the real MCP/subprocess fixture test. Use
   fresh disposable databases for every suite. Run the explicit live probe only
   when provider usage is authorized.
6. Record actual model telemetry, missing telemetry, latency and token usage.
   Never infer remaining subscription quota or billing from token counts alone.

```sh
bun run test -- tests/unit/memory-provider.test.ts tests/integration/memory-workflow.test.ts tests/e2e/memory-workflow.test.ts
bun scripts/verify-memory-workflow.ts --live
```

The live probe uses synthetic refund requirements and a non-project quota message.
It verifies no pre-approval write, one explicit approved memory, and recall after
MCP reconnection, then destroys its database and temporary project. Deterministic
provider fixtures test integration and failure handling; they do not measure model
quality. Never report mocked provider results as live model validation.

## Acceptance categories

- Evidence: missing IDs, edited/replayed batches, fabricated quotes and assistant
  claims without user evidence fail closed.
- Semantics: polite requests differ from exploratory questions; an experiment is
  not adoption, and an existing quantity is not a requested increase.
- Isolation: project B cannot read, approve, replace or recall project A's records.
- Lifecycle: duplicate approvals are idempotent, replacements are transactional,
  approval evidence is retained per candidate, clean retains memory and remove
  deletes workflow state with the selected project.
- Operations: only one database worker holds the lease, abandoned jobs recover,
  losing the lease cancels inference, retries are bounded and shutdown cancels
  only owned model processes.
- Provider: exact model allowlists, missing telemetry disclosure, process/output
  limits, environment isolation and equivalent schema validation for JSON text
  and structured-output envelopes.
- Clients: both generated instruction files require recall and assessment, while
  requiring separate user approval for promotion. Updates preserve outside-marker
  content and keep project opt-in explicit.

## Improvement without self-modifying rules

Use rejected and corrected synthetic examples to improve a reviewed fixture suite.
Do not let the worker edit its own prompts, permissions or approval policy. A new
model/prompt must pass the same isolation and review gates, with repeated quality
measurements on a held-out set before changing the default. Model agreement is
not proof of correctness; uncertain candidates remain outside active memory.

Known next steps are automatic source-validity maintenance, bounded transcript
imports, retention controls and richer scope-aware conflict review. Do not label
these as available until their end-to-end paths are implemented and tested.

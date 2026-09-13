# Memory protocol 2 verification

This change replaces model-authored quotes with server-resolved evidence IDs.
Message roles and original Unicode text remain unchanged. Unknown/duplicate IDs
fail closed. Approval and semantic verification remain required.

A live synthetic Turkish request completed extraction, verification, explicit
fixture approval and recall after reconnect in 41,945 ms. Haiku reported the
pinned model; Spark's actual-model telemetry remained unavailable. This proves
one exercised flow, not universal extraction correctness. No private project
conversation was used as a fixture.

## Checkpoint read comparison

Command: `bun scripts/benchmark-memory-checkpoints.ts`.
Disposable PostgreSQL database, five memories sharing one 1 MiB file, 20 iterations
per mode, alternating baseline/shared order on the local macOS machine.

| Metric | Separate per-memory reads | Shared per-request fingerprints |
| --- | ---: | ---: |
| Source bytes per request | 5,242,880 | 1,048,576 |
| Median elapsed ms | 7.70 | 1.28 |
| p95 elapsed ms | 13.58 | 4.20 |

This is an 80% source-read reduction for this shared-file scenario. The benchmark
uses warm local files. RSS before/after is not a peak-memory measurement and cannot
establish lower whole-process, PostgreSQL or Docker memory use. Whole-repository
indexing and Windows laptop performance remain separate acceptance work.

Fingerprints are retained only within the current request. Later requests rehash
source. Protected paths and bounded I/O checks remain in force. This is not a
transactional worktree snapshot or automatic semantic memory maintenance.

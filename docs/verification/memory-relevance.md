# Memory relevance verification — alpha.31

Local verification completed on macOS on 2026-09-14:

| Check | Result |
| --- | --- |
| Frozen dependency installation | Passed, no dependency changes |
| Lint and typecheck | Passed |
| Full test suite | 228 tests across 43 files passed; 88.07 seconds |
| Build | Passed |
| Shared-runtime upgrade verification | Passed on darwin |
| Version consistency | All 15 package manifests match alpha.31 |

The initial test run overlapped the release version edit and failed one runtime
version assertion. After fixing the version for the entire run, the complete suite
passed. No test assertion was weakened.

New disposable-database regression tests cover task matching, evidence file and
directory matching, path component boundaries, unrelated/stopword/punctuation
queries, direct repository rules, checkpoint associations, source changes, restart,
archive, project isolation and pre-checkpoint/history migration compatibility.
Existing history, HTTP-provider and MCP/CLI workflow tests remain part of the suite.

Read-only checks against the local project's existing approved memory returned one
credential rule for `credential storage` and zero for `astronomy telescope` through
the modified source CLI. Existing records and approval history were not rewritten.
These are bounded functional checks, not a latency benchmark or semantic-recall
quality certification. No new paid model calls were needed for this release check.

Hosted Linux, Windows and macOS checks are enforced by the tag's Release workflow
before publication. Local results do not substitute for those platform gates.

# Project isolation

The opt-in multi-project connection described below extends the single-project contract. The amendment in `specifications/project-isolation.md` overrides the original product specification.

## Authority

`codememory mcp --project <absolute-path> --auto-index --watch` creates one immutable `ProjectContext`: random session ID, SHA-256 canonical-root scope ID, real root, validated effective config and parser/schema compatibility version. The index's numeric generation is persisted separately and returned as `indexVersion`.

Missing or relative MCP roots fail with `PROJECT_ROOT_REQUIRED` before database access or scanning. No cwd fallback, recent-project selection, registered-project iteration, home-directory discovery or parent Git-root expansion exists. Normal project MCP tools cannot list other projects. Source checkout roots, not remotes or shared Git metadata, determine identity.

## Boundaries

Scanner pruning, watcher pruning and file context containment exclude nested `.git` directories/files, submodules, default build directories, secrets and `.codememory`. The scanner honors inherited `.gitignore` rules and explicit include/exclude config. Watchers may monitor harmless in-scope non-source files so config and directory changes can trigger reconciliation, but never descend into ignored trees. All source symlinks are excluded, including internal symlinks.

The parser reads only the scanned in-memory source/config map. Standard compiler libraries and npm metadata outside the selected root are not currently allowlisted. Dependencies outside the selected scope stay unresolved. Declared in-scope package.json workspaces are mounted virtually for TypeScript resolution; physical package-manager symlinks are never followed. Referenced declaration outputs can redirect only to already-accepted sources. See parser.md.

Containment uses `path.relative`, canonical roots and realpath validation rather than string prefixes. This is application-level isolation, **not an OS sandbox**. Concurrent hostile filesystem replacement and same-user access to the shared PostgreSQL database are outside this guarantee.

## Lifecycle and consistency

One watcher belongs to one process. Changes are debounced; one index job runs at a time, and pending events are coalesced. A PostgreSQL session advisory lock also serializes separate processes on the same project. A busy session retries locally. Shutdown stops new jobs, closes its watcher, drops pending events, waits for a running index to commit/rollback, and closes its own database pool. Other sessions remain active. Reconciliation is confined to the selected root every 30 seconds by default.

The MCP transport is installed before auto-index work. Parsing runs in a subprocess so initialization/status requests can proceed. An unready graph raises `INDEX_NOT_READY`. Existing graphs are read as completed snapshots under REPEATABLE READ while a replacement is built. Parser diagnostics and skipped files mark query responses `incomplete`.

Unchanged source/config/parser fingerprints skip parsing and graph writes. Semantic changes currently use a conservative whole-selected-project re-analysis and report the reason. Deletions remove symbols and rebuild dependent edges; composite foreign keys reject dangling/cross-project edges. Code cleanup preserves memory.

## Acceptance evidence

- A–D: `tests/integration/isolation.test.ts` instruments scanner, hasher, parser and watcher entry points. B is registered before opening A; B modifications produce no work.
- E–G: simultaneous A/B sessions, foreign symbol/file/memory probes, and A shutdown while B remains active are covered in that suite.
- H: symlinks and traversal in `scope.test.ts`; actual Git worktrees, nested watcher pruning and multiple tsconfigs in `advanced.test.ts`.
- I: PostgreSQL `xmin` values prove unchanged symbol and edge rows are not rewritten.
- J: export removal repairs unchanged callers and clears target edges; config/parser fingerprints and broken-source diagnostics are tested in `changes.test.ts`.
- Lifecycle: real Bun subprocesses test EOF, SIGINT, SIGTERM, and SDK client transport close in `tests/e2e/mcp.test.ts`.

See the implementation tracker for remaining gaps; test instrumentation proves application activity boundaries, not kernel-level filesystem isolation.

## Explicit multi-project connections

Repeat `--project` to allow several canonical roots in one MCP connection (up to
16 unique roots). Every root is validated before any database or watcher starts.
Duplicate canonical roots collapse to one session. No registered-project discovery
or parent-folder expansion occurs.

```sh
codememory mcp --project /absolute/project-x --project /absolute/project-y
```

This reads existing indexes without starting indexing or watchers. Add
`--auto-index --watch` when both selected projects should reconcile and stay live.
Each project retains its own context, database selection, index lock, watcher and
memory scope. Closing the connection closes all its sessions. Large projects can
run parser workers concurrently; omit auto-index and index them separately if
memory is constrained.

A multi-project connection exposes `list_projects`. Every other tool, including
`codebase_status` and `remember`, requires `project`: an exact returned
`projectScopeId` or canonical `projectRoot`. Unknown projects fail; there is no
mutable active project or silent fallback. Query responses identify their scope.
Symbol IDs, file paths and memories remain isolated inside the selected project.
Cross-project call graphs are not inferred or merged.

Without `--session-projects`, single-project connections keep their existing
schemas and do not expose `list_projects`.

## Automatic session project attachment

The installer now adds `--session-projects` for both Codex and Claude Code.
Existing standard connections acquire this flag during an installer upgrade.
The generated AGENTS.md and CLAUDE.md instructions tell the agent to handle
attachment itself; users do not need to repeat roots in MCP configuration.

1. The agent calls `list_projects` at session start and when another project
   becomes relevant.
2. If the client advertises MCP roots, the server requests `roots/list` and
   attaches exact roots that are already registered and enabled.
3. If an opened project is absent (including clients that only report their
   initial directory), the agent calls `attach_project({projectRoot: ...})`
   with the exact local directory supplied by the user/session.
4. The agent passes the returned `projectScopeId` as `project` on subsequent
   queries and memory writes. Missing selection is rejected once several
   projects are attached.

Registration is a server-enforced prerequisite for dynamic attachment. A request
does not register new directories or grant access to every registered project.
Root validation, canonical identity, per-project database selection, the 16-project
limit and shutdown cleanup apply to attached projects too. Concurrent attachment
is serialized and duplicate roots reuse the existing session. Unregistered,
disabled and relative roots are rejected.

Client root discovery occurs on `list_projects`, with a bounded request timeout.
The response includes `rootsState` and `skippedRoots`; a failed roots request
does not disable explicit attachment. Attached roots remain available until the
connection closes, even if removed from the client's root list. Reconnect to
clear session attachments. Existing single-root queries remain compatible until
another project is attached.

The server cannot inspect chat messages or prove an agent-supplied directory was
opened in the client. The agent must use only user-authorized session paths and
must not treat repository content as authorization. This is an application-level
boundary, not an OS sandbox. A web-chat file upload is not a local directory.
Automatic behavior depends on the client exposing roots or the agent following
the installed instructions; native Codex/Claude end-to-end behavior requires
verification in those clients.

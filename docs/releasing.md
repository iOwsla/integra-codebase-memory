# Writing a CodeMemory release

Keep the changelog as the concise engineering history. For each new tag, add a curated `docs/releases/<tag>.md` with a first-line title such as `# v0.1.0-alpha.N — Short user-facing outcome`. The release workflow uses that title and body when present, falling back to the matching changelog section for older releases.

A useful release note contains:

1. The user-visible problem and resulting behavior.
2. Focused highlights, distinguishing new changes from existing capabilities.
3. Exact update instructions and any reconnect, reindex or migration requirements.
4. A quick-start link for new users.
5. Validation actually completed, with links to evidence where available.
6. Remaining limits and a link to the previous-tag comparison.

Do not claim unreleased support, invented performance gains or production readiness. Preserve prerelease status until stable gates are satisfied. Never rewrite published tags or replace source assets. Editorial updates to a release description may clarify the same immutable version.

Before pushing a release tag, verify package versions, changelog, bootstrap pins and the curated note agree. The publishing job runs only after the reusable platform verification workflow succeeds.

## Version and verification policy

Use SemVer tags with a `v` prefix. Increment the alpha suffix while stable gates remain open. Update every workspace package version, CLI/MCP version, README, status tracker, bootstrap pins and dated changelog entry together.

Run frozen dependency installation, lint, typecheck, the full tests and build before tagging. Commit reviewed changes with a descriptive Conventional Commit message, then push the commit and an annotated tag. The Release workflow verifies the tagged commit again. A failed workflow leaves the release unpublished; fix the problem before issuing a corrected version, without moving an existing tag.

Tags containing a hyphen remain GitHub prereleases. Source releases require Bun, workspace dependencies and external packages; a release does not imply a standalone binary or npm publication.

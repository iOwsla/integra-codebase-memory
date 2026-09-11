# Releases

Public releases use SemVer tags with a `v` prefix. While production gates in
`implementation-status.md` remain open, publish prereleases such as
`v0.1.0-alpha.1`; increment the prerelease number for subsequent alpha releases.

Before tagging, update all workspace package versions, the CLI and MCP server
versions, README, status tracker and the dated changelog entry. Run the frozen
dependency install, lint, typecheck, full tests and build. Commit the reviewed
changes with a descriptive Conventional Commit message, then push the commit
and an annotated tag without rewriting published history.

The Release workflow reruns CI on the tagged commit. Only successful verification
allows a GitHub release to be created from its changelog entry. Tags containing
a hyphen produce GitHub prereleases. A failed workflow leaves the release
unpublished; investigate the failure before issuing a corrected version. Do not
move an existing public version tag.

These are source releases. The Bun build depends on the workspace and external
packages; no standalone binary or npm publication is implied.

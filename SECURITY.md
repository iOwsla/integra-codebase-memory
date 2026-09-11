# Security

CodeMemory handles private source. No telemetry, external uploads or embeddings are enabled. Do not add source upload paths or global discovery without an explicit product decision. Keep every query and mutation scoped by immutable ProjectContext and parameterize SQL. Do not expose secret files or follow symlinks. MCP tools do not edit source code.

Application containment is not an OS sandbox. The database account can access all locally stored projects; use OS/database isolation between untrusted users. Default Compose credentials are for loopback development only.

Report reproducible security problems privately to the repository maintainer. Redact source, credentials and local paths from reports.

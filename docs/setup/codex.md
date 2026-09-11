# Codex setup

For automatic project-only integration, use the [installer](installer.md).

Complete the [shared setup](common.md) first. From the CodeMemory installation:

```sh
bun run connect:codex /absolute/target-project
bun run connect:codex /absolute/target-project --write
```

The first command previews the configuration; the second creates the target
project's `.codex/config.toml`. Existing differing settings are not overwritten:
merge the previewed table into the existing file in that case. You can repeat an
identical installation safely. The generated file contains machine-specific
paths; add it to the target project's Git ignore rules.

Manual configuration example:

```toml
[mcp_servers.integra_code_memory]
command = "/absolute/path/to/bun"
args = ["/absolute/integra-codebase-memory/apps/cli/src/index.ts", "mcp", "--project", "/absolute/target-project", "--auto-index", "--watch"]
cwd = "/absolute/target-project"
env_vars = ["DATABASE_URL"]
startup_timeout_sec = 30
tool_timeout_sec = 60
enabled = true
```

Codex loads project-scoped `.codex/config.toml` settings for trusted projects.
Connection settings and AI instructions are separate files. Add the
[ready-to-copy block](../instructions/AGENTS.md) to `AGENTS.md` at the target project
root. This repository's AGENTS.md already contains the block. If global rules
require another server's tools, clarify the distinction there as well.

Restart the Codex connection or reopen the application, then open the target
project. Confirm that `integra_code_memory` appears in the MCP list and perform
the [live query check](common.md#verification-and-troubleshooting). Some clients
prefix tool names with the server name; use the exposed version of each short
tool name in the instructions.

The setup command does not disable other MCP servers, change global settings or
automatically reload the current chat. The connection and a direct in-chat
`codebase_status` query have been verified for this repository; verify them again
on another machine.

Source: [Official Codex MCP configuration](https://learn.chatgpt.com/docs/extend/mcp?surface=cli).

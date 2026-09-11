# Claude Code setup

For automatic project-only integration, use the [installer](installer.md).

Complete the [shared setup](common.md) first and ensure the Claude Code CLI is
installed. Run this command **from the target project directory**:

```sh
cd /absolute/target-project
claude mcp add --transport stdio --scope local integra_code_memory -- \
  /absolute/path/to/bun \
  /absolute/integra-codebase-memory/apps/cli/src/index.ts \
  mcp --project /absolute/target-project --auto-index --watch
```

The `local` scope stores this entry in your personal Claude settings for this
project only. It does not apply machine-specific paths to other projects. If an
entry already exists, inspect it with `claude mcp get integra_code_memory` before
adding anything; do not create a duplicate with the same name. For a custom index
database, start Claude Code with CodeMemory's `DATABASE_URL` in its environment.
Do not put connection secrets in shell history or shared files.

## Team alternative: .mcp.json

You can merge the following server entry into `.mcp.json` at the project root.
Preserve other `mcpServers` entries. This is an alternative to the local setup
above; do not configure both with the same name. The example paths are specific
to a machine. Agree on your team's path and environment strategy and remove
secrets before sharing the configuration.

```json
{
  "mcpServers": {
    "integra_code_memory": {
      "type": "stdio",
      "command": "/absolute/path/to/bun",
      "args": [
        "/absolute/integra-codebase-memory/apps/cli/src/index.ts",
        "mcp", "--project", "/absolute/target-project",
        "--auto-index", "--watch"
      ]
    }
  }
}
```

Claude Code may prompt for trust or approval for project-scoped MCP entries.
This is client behavior; check it when verifying the connection.

## CLAUDE.md instructions

Claude Code's project instruction file is `CLAUDE.md` at the project root. Add the
[self-contained block](../instructions/CLAUDE.md) while preserving existing rules.

If the same project also uses Codex, you can place the block in AGENTS.md and
import it from CLAUDE.md:

```markdown
@AGENTS.md
```

When using the import, do not also copy the same block into CLAUDE.md. This
CodeMemory repository uses the import so both clients read the same instructions.

## Verify the connection

```sh
claude mcp list
claude mcp get integra_code_memory
```

Start or reopen Claude Code in the target directory. Use `/mcp` to check the
server connection and `/context` to check that CLAUDE.md instructions loaded.
Then perform the [live query check](common.md#verification-and-troubleshooting).
Do not consider the setup verified until an actual tool response confirms the
project root and index status.

This guide follows the official client documentation. Our STDIO server has been
tested with a real SDK client; this change did not include an end-to-end setup
run inside a Claude Code session.

Sources: [Claude Code MCP](https://code.claude.com/docs/en/mcp),
[CLAUDE.md and AGENTS.md imports](https://code.claude.com/docs/en/memory).

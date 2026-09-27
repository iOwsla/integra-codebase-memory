import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { createProjectContext } from "@codememory/shared";
import { Client } from "@modelcontextprotocol/client";
import { StdioClientTransport } from "@modelcontextprotocol/client/stdio";

// This publishes a real project index. Use simulate:project for disposable exercises.
const context = await createProjectContext(process.argv[2]);
const query = process.argv[3] ?? "createProjectContext";
const transport = new StdioClientTransport({
  command: process.execPath,
  args: [
    fileURLToPath(new URL("../apps/cli/src/index.ts", import.meta.url)),
    "mcp",
    "--project",
    context.canonicalRoot,
    "--auto-index",
    "--watch",
  ],
  env: Object.fromEntries(
    Object.entries(process.env).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  ),
  stderr: "pipe",
});
transport.stderr?.on("data", (chunk) => {
  if (process.env.CODEMEMORY_PROFILE === "1") process.stderr.write(chunk);
});
const client = new Client({ name: "codememory-connection-check", version: "1.0.0" });
try {
  console.error("Connecting to the selected MCP server...");
  await client.connect(transport);
  console.error("Listing MCP tools...");
  const names = (await client.listTools()).tools.map((tool) => tool.name);
  for (const name of [
    "codebase_status",
    "search_symbols",
    "find_callers",
    "find_callees",
    "find_references",
    "trace_dependencies",
  ])
    assert(names.includes(name));
  assert(client.getInstructions()?.includes("codebase_status"));
  let status: Record<string, unknown> = {};
  console.error("Checking project readiness...");
  const deadline = Date.now() + 150000;
  while (Date.now() < deadline) {
    const result = await client.callTool({ name: "codebase_status", arguments: {} });
    assert(!result.isError);
    status = result.structuredContent as Record<string, unknown>;
    assert.equal(status.projectRoot, context.canonicalRoot);
    if (status.state === "ERROR" && status.error !== "INDEX_BUSY")
      throw new Error(`Index startup failed: ${status.error}`);
    if (status.state === "READY" && status.pendingChanges === 0) break;
    await Bun.sleep(2000);
  }
  assert(status.state === "READY" && status.pendingChanges === 0, "Index was not ready");
  const workflow = await client.callTool({ name: "memory_workflow_status", arguments: {} });
  assert(!workflow.isError);
  console.error("Checking symbol search and callers...");
  const result = await client.callTool({ name: "search_symbols", arguments: { query, limit: 10 } });
  assert(!result.isError);
  const rows = (result.structuredContent as { results: { id: string; name: string }[] }).results;
  const symbol = rows.find((row) => row.name === query);
  assert(symbol, "Exact symbol not found; provide a declared symbol name as the second argument");
  const callers = await client.callTool({
    name: "find_callers",
    arguments: { symbolId: symbol.id, limit: 10 },
  });
  assert(!callers.isError);
  console.log(
    JSON.stringify(
      {
        connected: true,
        projectRoot: status.projectRoot,
        indexVersion: status.indexVersion,
        autoIndex: status.autoIndex,
        watcher: status.watcher,
        memoryWorkflowEnabled: (workflow.structuredContent as { enabled: boolean }).enabled,
        toolCount: names.length,
        query,
        callersReturned: (callers.structuredContent as { results: unknown[] }).results.length,
        incomplete: status.incomplete,
        instructionsReceived: true,
      },
      null,
      2,
    ),
  );
} finally {
  await client.close();
}

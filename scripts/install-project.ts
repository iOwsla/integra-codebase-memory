import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createProjectContext } from "@codememory/shared";
import { Command } from "commander";
import { connectCodex } from "./connect-codex";

const serverRoot = fileURLToPath(new URL("../", import.meta.url));
const name = "integra_code_memory";
const start = "<!-- integra-code-memory:start -->";
const end = "<!-- integra-code-memory:end -->";
interface Edit {
  path: string;
  before: string | null;
  after: string;
  mode: number;
}

async function statOptional(path: string) {
  return lstat(path).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return null;
  });
}
async function readTarget(root: string, relative: string) {
  const path = resolve(root, relative);
  const parent = dirname(path);
  if (parent !== root) {
    const info = await statOptional(parent);
    if (info && (!info.isDirectory() || info.isSymbolicLink()))
      throw new Error(`Refusing redirected directory: ${relative}`);
  }
  const info = await statOptional(path);
  if (!info) return { text: null, mode: 0o600 };
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1)
    throw new Error(`Refusing linked or non-regular file: ${relative}`);
  if (info.size > 1024 * 1024) throw new Error(`Configuration exceeds 1 MiB: ${relative}`);
  return { text: await readFile(path, "utf8"), mode: info.mode & 0o777 };
}
function marked(existing: string | null, body: string, first = start, last = end) {
  const text = existing ?? "";
  const begins = text.split(first).length - 1,
    ends = text.split(last).length - 1;
  const block = `${first}\n${body.trim()}\n${last}`;
  if (!begins && !ends)
    return `${text}${text && !text.endsWith("\n") ? "\n" : ""}${text ? "\n" : ""}${block}\n`;
  if (begins !== 1 || ends !== 1 || text.indexOf(last) < text.indexOf(first))
    throw new Error("Ambiguous installer markers; repair them before installation");
  return text.slice(0, text.indexOf(first)) + block + text.slice(text.indexOf(last) + last.length);
}
function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function compatible(actual: unknown, expected: Record<string, unknown>) {
  return (
    object(actual) &&
    Object.entries(expected).every(
      ([key, value]) => JSON.stringify(actual[key]) === JSON.stringify(value),
    )
  );
}

function parseToml(text: string) {
  try {
    return Bun.TOML.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error("Invalid Codex TOML; inspect the local config before retrying");
  }
}
function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new Error("Invalid Claude JSON; inspect the local config before retrying");
  }
}

export async function installProject(root: string, client: string, write = false) {
  if (!["codex", "claude", "both"].includes(client))
    throw new Error("Client must be codex, claude or both");
  const context = await createProjectContext(root);
  const selected = context.canonicalRoot;
  const edits: Edit[] = [];
  const plan = async (path: string, transform: (before: string | null) => string) => {
    const previous = await readTarget(selected, path);
    edits.push({
      path,
      before: previous.text,
      after: transform(previous.text),
      mode: previous.mode,
    });
  };
  const entry = resolve(serverRoot, "apps/cli/src/index.ts");
  const args = [entry, "mcp", "--project", selected, "--auto-index", "--watch"];
  if (client !== "claude") {
    // Reuse the existing Codex configuration generator without writing anything.
    const generated = (await connectCodex(selected, process.execPath, entry)).config;
    const expected = (parseToml(generated).mcp_servers as Record<string, Record<string, unknown>>)[
      name
    ];
    await plan(".codex/config.toml", (before) => {
      const parsed = parseToml(before ?? "");
      const servers = parsed.mcp_servers;
      if (servers !== undefined && !object(servers)) throw new Error("Invalid mcp_servers table");
      if (object(servers) && Object.hasOwn(servers, name)) {
        if (!compatible(servers[name], expected as Record<string, unknown>))
          throw new Error("Existing CodeMemory Codex entry conflicts; nothing was written");
        return before as string;
      }
      const result = `${before ?? ""}\n${generated}`;
      // Inline TOML tables may not be extensible: reject before any file is written.
      parseToml(result);
      return result;
    });
  }
  if (client !== "codex") {
    await plan(".mcp.json", (before) => {
      const parsed: unknown = parseJson(before ?? "{}");
      if (!object(parsed) || (parsed.mcpServers !== undefined && !object(parsed.mcpServers)))
        throw new Error("Invalid .mcp.json configuration");
      const servers = (parsed.mcpServers ?? {}) as Record<string, unknown>;
      const expected = { type: "stdio", command: process.execPath, args };
      if (Object.hasOwn(servers, name)) {
        if (!compatible(servers[name], expected))
          throw new Error("Existing CodeMemory Claude entry conflicts; nothing was written");
        return before as string;
      }
      return `${JSON.stringify({ ...parsed, mcpServers: { ...servers, [name]: expected } }, null, 2)}\n`;
    });
  }
  const template = await readFile(resolve(serverRoot, "docs/instructions/AGENTS.md"), "utf8");
  const body = template.slice(template.indexOf(start) + start.length, template.indexOf(end)).trim();
  const claude = client !== "codex" ? await readTarget(selected, "CLAUDE.md") : null;
  const importsAgents = /^@(?:\.\/)?AGENTS\.md\s*$/m.test(claude?.text ?? "");
  if (client !== "claude" || importsAgents)
    await plan("AGENTS.md", (before) => marked(before, body));
  if (client !== "codex" && !importsAgents)
    await plan("CLAUDE.md", (before) => marked(before, client === "both" ? "@AGENTS.md" : body));
  await plan(".gitignore", (before) =>
    marked(
      before,
      "/.codex/config.toml\n/.mcp.json",
      "# integra-code-memory:local-config:start",
      "# integra-code-memory:local-config:end",
    ),
  );

  const changed = edits.filter((edit) => edit.before !== edit.after);
  if (write) {
    // Validate every planned destination again before applying any changes.
    for (const edit of edits)
      if ((await readTarget(selected, edit.path)).text !== edit.before)
        throw new Error("Files changed during planning; rerun the installer");
    for (const edit of changed) {
      const destination = resolve(selected, edit.path);
      if ((await readTarget(selected, edit.path)).text !== edit.before)
        throw new Error("File changed during installation; rerun after reviewing partial changes");
      await mkdir(dirname(destination), { recursive: true });
      const temporary = resolve(dirname(destination), `.codememory-install-${randomUUID()}.tmp`);
      try {
        await writeFile(temporary, edit.after, { flag: "wx", mode: edit.mode });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    }
  }
  // Never print existing config contents: they may contain credentials for other servers.
  return {
    projectRoot: selected,
    client,
    applied: write,
    changedFiles: changed.map((edit) => edit.path),
    unchangedFiles: edits.filter((edit) => edit.before === edit.after).map((edit) => edit.path),
    next: "Open this project in the selected client, approve/reload its MCP connection if prompted, then call codebase_status. PostgreSQL must be running. No database or index work was performed by this installer.",
  };
}
if (import.meta.main) {
  const command = new Command()
    .description("Install CodeMemory only into an explicitly selected project")
    .requiredOption("--project <absolute-path>", "Target project; no parent/root inference")
    .requiredOption("--client <client>", "codex, claude or both")
    .option("--write", "Apply changes (default: preview paths only)");
  command.parse();
  const options = command.opts<{ project: string; client: string; write?: boolean }>();
  try {
    console.log(
      JSON.stringify(await installProject(options.project, options.client, options.write), null, 2),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Installation failed");
    process.exitCode = 1;
  }
}

import { randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, resolve } from "node:path";
import { createProjectContext } from "@codememory/shared";
import { Command } from "commander";
import { connectCodex } from "./connect-codex";
import { runtimeRoot } from "./runtime-root";
import { installManagementCli, saveRegistration } from "./setup/cli-state";
import { checkLocalPath, serviceDirectory } from "./setup/service-state";

const serverRoot = runtimeRoot;
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

/** Only retarget a recognizable same-project connection; preserve all custom settings. */
function upgradedEntry(actual: unknown, expected: Record<string, unknown>) {
  if (!object(actual) || !Array.isArray(actual.args) || !Array.isArray(expected.args))
    throw new Error("Unrecognized CodeMemory entry; review its configuration manually.");
  const old = actual.args;
  const next = expected.args;
  if (
    typeof actual.command !== "string" ||
    !["bun", "bun.exe"].includes(basename(actual.command)) ||
    typeof old[0] !== "string" ||
    !isAbsolute(old[0]) ||
    JSON.stringify(old.slice(1)) !== JSON.stringify(next.slice(1))
  )
    throw new Error(
      "Upgrade requires an existing Bun MCP entry for this exact project with standard arguments.",
    );
  const suffix = String(next[0]).endsWith("managed-mcp.ts")
    ? "scripts/managed-mcp.ts"
    : "apps/cli/src/index.ts";
  if (!old[0].replaceAll("\\", "/").endsWith(`/${suffix}`))
    throw new Error(
      "Upgrade must preserve database mode. For an external database or alpha.13 installation use --skip-services (-SkipServices in PowerShell); do not silently switch databases.",
    );
  if (
    object(expected.env) &&
    (!object(actual.env) ||
      actual.env.CODEMEMORY_SERVICE_DIR !== expected.env.CODEMEMORY_SERVICE_DIR)
  )
    throw new Error(
      "Managed database state directory differs. Review this connection manually to preserve its data.",
    );
  return {
    ...actual,
    command: expected.command,
    args: expected.args,
    ...(expected.cwd ? { cwd: expected.cwd } : {}),
  };
}
function upgradeCodex(text: string, actual: unknown, expected: Record<string, unknown>) {
  const updated = upgradedEntry(actual, expected);
  const header = /^\[mcp_servers\.integra_code_memory\][ \t]*(?:#[^\r\n]*)?\r?$/m.exec(text);
  if (!header)
    throw new Error(
      "Upgrade needs a standard [mcp_servers.integra_code_memory] table; review custom TOML manually.",
    );
  const startAt = header.index + header[0].length;
  const remainder = text.slice(startAt);
  const nextHeader = /^\s*\[/m.exec(remainder);
  const endAt = nextHeader ? startAt + nextHeader.index : text.length;
  let body = text.slice(startAt, endAt);
  for (const field of ["command", "args", "cwd"] as const) {
    const pattern = new RegExp(`^${field}[ \t]*=[^\r\n]*$`, "gm");
    const matches = [...body.matchAll(pattern)];
    if (matches.length !== 1)
      throw new Error(
        "Upgrade needs standard single-line command, args and cwd fields; review custom TOML manually.",
      );
    body = body.replace(pattern, () => `${field} = ${JSON.stringify(updated[field])}`);
  }
  const result = text.slice(0, startAt) + body + text.slice(endAt);
  const parsed = parseToml(result).mcp_servers as Record<string, unknown>;
  if (JSON.stringify(parsed[name]) !== JSON.stringify(updated))
    throw new Error("Upgrade could not preserve the complete Codex entry; nothing was written.");
  return result;
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

export async function installProject(
  root: string,
  client: string,
  write = false,
  managed = false,
  upgrade = false,
) {
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
  const entry = resolve(serverRoot, managed ? "scripts/managed-mcp.ts" : "apps/cli/src/index.ts");
  if (!(await stat(process.execPath)).isFile() || !(await stat(entry)).isFile())
    throw new Error(
      "Selected runtime executable or MCP entry is missing; reinstall this release before updating project settings",
    );
  const args = [entry, "mcp", "--project", selected, "--auto-index", "--watch"];
  if (client !== "claude") {
    // Reuse the existing Codex configuration generator without writing anything.
    const generated =
      (await connectCodex(selected, process.execPath, entry)).config +
      (managed
        ? `\n[mcp_servers.${name}.env]\nCODEMEMORY_SERVICE_DIR = ${JSON.stringify(serviceDirectory())}\n`
        : "");
    const expected = (parseToml(generated).mcp_servers as Record<string, Record<string, unknown>>)[
      name
    ];
    await plan(".codex/config.toml", (before) => {
      const parsed = parseToml(before ?? "");
      const servers = parsed.mcp_servers;
      if (servers !== undefined && !object(servers)) throw new Error("Invalid mcp_servers table");
      if (object(servers) && Object.hasOwn(servers, name)) {
        if (!compatible(servers[name], expected as Record<string, unknown>)) {
          if (upgrade)
            return upgradeCodex(
              before as string,
              servers[name],
              expected as Record<string, unknown>,
            );
          throw new Error(
            "Existing CodeMemory Codex entry conflicts; use --upgrade after reviewing the selected project",
          );
        }
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
      const expected = {
        type: "stdio",
        command: process.execPath,
        args,
        ...(managed ? { env: { CODEMEMORY_SERVICE_DIR: serviceDirectory() } } : {}),
      };
      if (Object.hasOwn(servers, name)) {
        if (!compatible(servers[name], expected)) {
          if (upgrade)
            return `${JSON.stringify({ ...parsed, mcpServers: { ...servers, [name]: upgradedEntry(servers[name], expected) } }, null, 2)}\n`;
          throw new Error(
            "Existing CodeMemory Claude entry conflicts; use --upgrade after reviewing the selected project",
          );
        }
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
  let backupDirectory: string | undefined;
  if (write) {
    // Validate every planned destination again before applying any changes.
    for (const edit of edits)
      if ((await readTarget(selected, edit.path)).text !== edit.before)
        throw new Error("Files changed during planning; rerun the installer");
    if (upgrade && changed.some((edit) => edit.before !== null)) {
      backupDirectory = resolve(serviceDirectory(), "../backups", randomUUID());
      await checkLocalPath(backupDirectory);
      for (const edit of changed) {
        if (edit.before === null) continue;
        const backup = resolve(backupDirectory, edit.path);
        await mkdir(dirname(backup), { recursive: true, mode: 0o700 });
        await writeFile(backup, edit.before, { flag: "wx", mode: 0o600 });
      }
    }
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
    runtimeVerified: true,
    upgrade,
    ...(backupDirectory ? { backupDirectory } : {}),
    changedFiles: changed.map((edit) => edit.path),
    unchangedFiles: edits.filter((edit) => edit.before === edit.after).map((edit) => edit.path),
    next: "Open this project in the selected client, approve/reload its MCP connection if prompted, then call codebase_status. PostgreSQL must be running. Indexing starts when the client opens the connection.",
  };
}
if (import.meta.main && process.argv[1]?.endsWith("install-project.ts")) {
  const command = new Command()
    .description("Install CodeMemory only into an explicitly selected project")
    .requiredOption("--project <absolute-path>", "Target project; no parent/root inference")
    .requiredOption("--client <client>", "codex, claude or both")
    .option(
      "--upgrade",
      "Back up and retarget existing same-project CodeMemory connections; preserve database mode",
    )
    .option("--write", "Apply changes (default: preview paths only)")
    .option(
      "--with-services",
      "Prepare Docker and managed PostgreSQL before writing project configuration",
    );
  command.parse();
  const options = command.opts<{
    project: string;
    client: string;
    write?: boolean;
    withServices?: boolean;
    upgrade?: boolean;
  }>();
  try {
    // Preflight configuration conflicts and project paths before system changes.
    const preview = await installProject(
      options.project,
      options.client,
      false,
      options.withServices,
      options.upgrade,
    );
    if (options.write) {
      await installManagementCli();
      await saveRegistration({
        root: preview.projectRoot,
        client: options.client as "codex" | "claude" | "both",
        managed: !!options.withServices,
        enabled: true,
      });
    }
    if (options.withServices && options.write) {
      const { setupServices } = await import("./setup/services");
      await setupServices();
    }
    console.log(
      JSON.stringify(
        options.write
          ? await installProject(
              options.project,
              options.client,
              true,
              options.withServices,
              options.upgrade,
            )
          : { ...preview, servicesPlanned: !!options.withServices },
        null,
        2,
      ),
    );
  } catch (error) {
    console.error(error instanceof Error ? error.message : "Installation failed");
    process.exitCode = 1;
  }
}

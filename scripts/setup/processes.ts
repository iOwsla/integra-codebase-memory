import { execFile } from "node:child_process";
import { readdir, readFile } from "node:fs/promises";
import { basename, resolve } from "node:path";
import { promisify } from "node:util";
import { activeRuntime, managementDirectory, sharedEntry } from "./cli-state";
import { checkLocalPath } from "./service-state";

const exec = promisify(execFile);
export const origin = "https://github.com/iOwsla/integra-codebase-memory.git";
export interface ProcessIdentity {
  pid: number;
  parent: number;
  started: string;
  command: string;
}
const windowsInventory = `$ErrorActionPreference='Stop'
@(Get-CimInstance Win32_Process -Filter "Name = 'bun.exe'" | ForEach-Object {
  @{pid=[int]$_.ProcessId;parent=[int]$_.ParentProcessId;started=$_.CreationDate.ToUniversalTime().Ticks.ToString();command=$_.CommandLine}
}) | ConvertTo-Json -Compress`;
async function powershell(script: string, env = process.env) {
  return exec(
    "powershell.exe",
    [
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-EncodedCommand",
      Buffer.from(script, "utf16le").toString("base64"),
    ],
    { env, maxBuffer: 16 * 1024 * 1024, timeout: 15000 },
  );
}
export async function processInventory(): Promise<ProcessIdentity[]> {
  if (process.platform === "win32") {
    const { stdout } = await powershell(windowsInventory);
    const records = JSON.parse(stdout.trim() || "[]");
    return Array.isArray(records) ? records : [records];
  }
  const { stdout } = await exec("ps", ["-ax", "-o", "pid=,ppid=,lstart=,command="], {
    maxBuffer: 16 * 1024 * 1024,
    env: { ...process.env, LC_ALL: "C" },
  });
  return stdout.split("\n").flatMap((line) => {
    const match = /^\s*(\d+)\s+(\d+)\s+(\S+\s+\S+\s+\d+\s+[\d:]+\s+\d+)\s+(.*)$/.exec(line);
    return match
      ? [
          {
            pid: Number(match[1]),
            parent: Number(match[2]),
            started: match[3] ?? "",
            command: match[4] ?? "",
          },
        ]
      : [];
  });
}
const normalize = (path: string) =>
  process.platform === "win32" ? path.replaceAll("\\", "/").toLowerCase() : path;
function unquote(value: string) {
  return value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
/** Conservative legacy format; never match a process by name or PID alone. */
export function matchMcp(command: string, projects: string[], entries: string[]) {
  const match =
    /^(?:"([^"]+)"|(\S+))\s+(.+?)\s+mcp\s+--project\s+(.+?)\s+--auto-index\s+--watch\s*$/.exec(
      command,
    );
  if (
    !match ||
    !/^bun(?:\.exe)?$/i.test(
      (match[1] || match[2] || "").replaceAll("\\", "/").split("/").pop() || "",
    )
  )
    return false;
  return (
    entries.some((entry) => normalize(entry) === normalize(unquote(match[3] ?? ""))) &&
    projects.some((project) => normalize(project) === normalize(unquote(match[4] ?? "")))
  );
}
export async function verifiedRuntime(root: string) {
  await checkLocalPath(root);
  const manifest = JSON.parse(await readFile(resolve(root, "package.json"), "utf8"));
  if (
    manifest.name !== "integra-codebase-memory" ||
    !/^\d+\.\d+\.\d+(?:-alpha\.\d+)?$/.test(manifest.version)
  )
    throw new Error("Unrecognized runtime manifest");
  const remote = await exec("git", ["-C", root, "remote", "get-url", "origin"]);
  if (remote.stdout.trim() !== origin) throw new Error("Runtime origin differs from CodeMemory");
  return { root, version: manifest.version as string };
}
export async function managedRuntimeRoots() {
  const releaseDirectory = resolve(managementDirectory(), "../releases");
  await checkLocalPath(releaseDirectory);
  const directories = await readdir(releaseDirectory, { withFileTypes: true }).catch(
    (e: NodeJS.ErrnoException) => {
      if (e.code !== "ENOENT") throw e;
      return [];
    },
  );
  if (directories.length > 200) throw new Error("Too many release directories to inspect safely");
  const roots = directories
    .filter((d) => d.isDirectory() && !d.name.startsWith("."))
    .map((d) => resolve(releaseDirectory, d.name));
  const active = await activeRuntime().catch(() => null);
  if (active && !roots.includes(active.root)) roots.push(active.root);
  const verified: string[] = [];
  for (const root of roots)
    if (
      await verifiedRuntime(root).then(
        () => true,
        () => false,
      )
    )
      verified.push(root);
  return verified;
}
export async function ownedProcesses(projects: string[]) {
  const verified = await managedRuntimeRoots();
  const entries = [
    sharedEntry(false),
    sharedEntry(true),
    ...verified.flatMap((root) => [
      resolve(root, "scripts/managed-mcp.ts"),
      resolve(root, "apps/cli/src/index.ts"),
    ]),
  ];
  const inventory = await processInventory();
  for (const candidate of inventory) {
    const match = /^(?:"[^"]+"|\S+)\s+(.+?)\s+mcp\s+--project\s+/.exec(candidate.command);
    const entry = match ? unquote(match[1] ?? "") : "";
    if (
      /\/(?:scripts\/managed-mcp|apps\/cli\/src\/index)\.ts$/.test(entry.replaceAll("\\", "/")) &&
      matchMcp(candidate.command, projects, [entry]) &&
      !entries.some((known) => normalize(known) === normalize(entry))
    )
      throw new Error(
        `MCP process ${candidate.pid} is outside verified CodeMemory runtimes. Close that client connection before upgrading.`,
      );
  }
  const selected = inventory.filter(
    (p) => p.pid !== process.pid && matchMcp(p.command, projects, entries),
  );
  // Parser subprocesses are included only when their parent and exact entry belong to this runtime.
  const parents = new Set(selected.map((p) => p.pid));
  const workers = inventory.filter(
    (p) =>
      parents.has(p.parent) &&
      verified.some((root) => {
        const entry = resolve(root, "packages/plugin-typescript/src/worker.ts");
        const match = /^(?:"([^"]+)"|(\S+))\s+(.+?)\s*$/.exec(p.command);
        return (
          !!match &&
          /^bun(?:\.exe)?$/i.test(basename(match[1] || match[2] || "")) &&
          normalize(unquote(match[3] ?? "")) === normalize(entry)
        );
      }),
  );
  return [...selected, ...workers];
}
function same(a: ProcessIdentity, b: ProcessIdentity) {
  return a.pid === b.pid && a.started === b.started && a.command === b.command;
}
export async function stopOwnedProcesses(selected: ProcessIdentity[]) {
  if (!selected.length) return [];
  if (process.platform === "win32") {
    // Revalidate creation time AND command in the same helper that terminates the process.
    await powershell(
      `$ErrorActionPreference='Stop'
foreach ($candidate in ($env:CODEMEMORY_STOP_CANDIDATES | ConvertFrom-Json)) {
 $current = Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$candidate.pid)
 if ($current -and $current.CreationDate.ToUniversalTime().Ticks.ToString() -eq $candidate.started -and $current.CommandLine -ceq $candidate.command) {
   try { Stop-Process -Id ([int]$candidate.pid) -Force -ErrorAction Stop }
   catch { if (Get-CimInstance Win32_Process -Filter ("ProcessId = " + [int]$candidate.pid)) { throw } }
 }
}`,
      { ...process.env, CODEMEMORY_STOP_CANDIDATES: JSON.stringify(selected) },
    );
  } else {
    for (const signal of ["SIGTERM", "SIGKILL"] as const) {
      for (const candidate of selected) {
        const current = (await processInventory()).find((p) => same(p, candidate));
        if (current)
          try {
            process.kill(current.pid, signal);
          } catch (e) {
            if ((e as NodeJS.ErrnoException).code !== "ESRCH") throw e;
          }
      }
      const deadline = Date.now() + (signal === "SIGTERM" ? 5000 : 2000);
      while (Date.now() < deadline) {
        if (!(await processInventory()).some((p) => selected.some((s) => same(p, s)))) break;
        await new Promise((resolve) => setTimeout(resolve, 100));
      }
    }
  }
  const remaining = (await processInventory()).filter((p) => selected.some((s) => same(p, s)));
  if (remaining.length)
    throw new Error("Some CodeMemory processes did not stop; close their clients and retry");
  return selected.map((p) => p.pid);
}

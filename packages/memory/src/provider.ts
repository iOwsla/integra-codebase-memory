import { spawn } from "node:child_process";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, isAbsolute, join, resolve as resolvePath } from "node:path";
import { stripVTControlCharacters } from "node:util";
import { CodeMemoryError } from "@codememory/core";
import { z } from "zod";
import {
  extractionPrompt,
  extractionSchema,
  verificationPrompt,
  verificationSchema,
} from "./protocol";

export interface MemoryModelProvider {
  extract(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{ output: unknown; metrics: Record<string, unknown> }>;
  verify(
    input: unknown,
    signal?: AbortSignal,
  ): Promise<{ output: unknown; metrics: Record<string, unknown> }>;
}
export type ProcessRunner = (
  command: string,
  args: string[],
  input: string,
  cwd: string,
  signal?: AbortSignal,
) => Promise<string>;
/** Resolve native or npm-installed Windows CLIs without executing a command shell. */
export async function resolveModelCommand(
  command: string,
  platform = process.platform,
  searchPath = process.env.PATH ?? "",
) {
  if (platform !== "win32" || isAbsolute(command)) return { command, prefix: [] as string[] };
  const packageEntry =
    command === "codex" ? "@openai/codex/bin/codex.js" : "@anthropic-ai/claude-code/cli.js";
  for (const directory of searchPath
    .split(platform === "win32" ? ";" : delimiter)
    .filter(Boolean)) {
    const native = join(directory, `${command}.exe`);
    if (
      await access(native).then(
        () => true,
        () => false,
      )
    )
      return { command: native, prefix: [] as string[] };
    for (const base of ["node_modules", "../node_modules", "../lib/node_modules"]) {
      const entry = resolvePath(directory, base, packageEntry);
      if (
        await access(entry).then(
          () => true,
          () => false,
        )
      )
        return { command: process.execPath, prefix: [entry] };
    }
  }
  throw new CodeMemoryError(
    "MEMORY_PROVIDER_UNAVAILABLE",
    "Install the native or npm CLI and add its directory to PATH",
  );
}
const modelEnvironmentKeys = new Set([
  "PATH",
  "PATHEXT",
  "SYSTEMROOT",
  "COMSPEC",
  "WINDIR",
  "HOME",
  "USER",
  "LOGNAME",
  "__CF_USER_TEXT_ENCODING",
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "TEMP",
  "TMP",
  "TMPDIR",
  "LANG",
  "LC_ALL",
  "XDG_CONFIG_HOME",
  "CODEX_HOME",
  "CLAUDE_CONFIG_DIR",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "NO_PROXY",
]);
export function modelEnvironment(env: NodeJS.ProcessEnv = process.env) {
  return Object.fromEntries(
    Object.entries(env).filter(
      ([key, value]) => value !== undefined && modelEnvironmentKeys.has(key.toUpperCase()),
    ),
  );
}
/** No shell interpolation; only this invocation's process tree may be terminated. */
export const runModelProcess: ProcessRunner = async (command, args, input, cwd, signal) => {
  const executable = await resolveModelCommand(command);
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new CodeMemoryError("MEMORY_CANCELLED", "Worker stopped"));
    const child = spawn(executable.command, [...executable.prefix, ...args], {
      cwd,
      env: modelEnvironment(),
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    let output = "";
    let stderr = "";
    let bytes = 0;
    let failure: CodeMemoryError | undefined;
    const stop = (code: string) => {
      failure ??= new CodeMemoryError(
        code,
        "Model process failed; check CLI login, version and worker diagnostics",
      );
      if (child.pid) {
        if (process.platform === "win32") {
          const killer = spawn("taskkill.exe", ["/PID", String(child.pid), "/T", "/F"], {
            stdio: "ignore",
            windowsHide: true,
          });
          killer.on("error", () => child.kill());
        } else {
          try {
            process.kill(-child.pid, "SIGKILL");
          } catch {
            child.kill("SIGKILL");
          }
        }
      }
    };
    const cancel = () => stop("MEMORY_CANCELLED");
    const timer = setTimeout(() => stop("MEMORY_PROVIDER_TIMEOUT"), 120000);
    signal?.addEventListener("abort", cancel, { once: true });
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data: string) => {
      bytes += Buffer.byteLength(data);
      if (bytes > 2 * 1024 * 1024) stop("MEMORY_OUTPUT_LIMIT");
      else output += data;
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (data: string) => {
      bytes += Buffer.byteLength(data);
      if (bytes > 2 * 1024 * 1024) stop("MEMORY_OUTPUT_LIMIT");
      else stderr = (stderr + data).slice(-8192);
    });
    child.stdin.on("error", () => {});
    child.on("error", () => {
      failure ??= new CodeMemoryError(
        "MEMORY_PROVIDER_UNAVAILABLE",
        "Required CLI unavailable; install and sign in before retrying",
      );
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", cancel);
      if (failure) reject(failure);
      else if (code !== 0) reject(providerExitError(code, stderr));
      else resolve(output);
    });
    child.stdin.end(input);
  });
};
/** Emit only fixed diagnostic categories: stderr may contain credentials or input echoes. */
export function providerExitError(code: number | null, stderr: string) {
  const clean = stripVTControlCharacters(stderr);
  const schema = /--json-schema is not a valid JSON Schema|no schema with key or ref/i.test(clean);
  return new CodeMemoryError(
    schema ? "MEMORY_PROVIDER_SCHEMA_UNSUPPORTED" : "MEMORY_PROVIDER_EXIT",
    schema
      ? `Model CLI rejected the JSON Schema dialect (exit ${code ?? "signal"}); update CodeMemory and check CLI schema compatibility. Raw provider output omitted.`
      : `Model CLI exited unsuccessfully (exit ${code ?? "signal"}); cause is unclassified. Check CLI version and local diagnostics. Raw provider output omitted to protect credentials and conversation text.`,
  );
}
export class CliMemoryProvider implements MemoryModelProvider {
  constructor(
    private readonly runner: ProcessRunner = runModelProcess,
    private readonly prompts = { extraction: extractionPrompt, verification: verificationPrompt },
  ) {}
  async extract(input: unknown, signal?: AbortSignal) {
    return this.call("spark", input, signal);
  }
  async verify(input: unknown, signal?: AbortSignal) {
    return this.call("haiku", input, signal);
  }
  private async call(kind: "spark" | "haiku", input: unknown, signal?: AbortSignal) {
    const dir = await mkdtemp(join(tmpdir(), "codememory-model-"));
    const started = Date.now();
    try {
      const model = kind === "spark" ? "gpt-5.3-codex-spark" : "claude-haiku-4-5-20251001";
      const schema = JSON.stringify(
        z.toJSONSchema(kind === "spark" ? extractionSchema : verificationSchema, {
          target: kind === "haiku" ? "draft-7" : "draft-2020-12",
        }),
      );
      let args: string[];
      let prompt: string;
      if (kind === "spark") {
        await writeFile(join(dir, "schema.json"), schema, { mode: 0o600 });
        args = [
          "exec",
          "--ignore-user-config",
          "--ephemeral",
          "--skip-git-repo-check",
          "--sandbox",
          "read-only",
          "--model",
          model,
          "-c",
          'approval_policy="never"',
          "-c",
          'model_reasoning_effort="low"',
          "-c",
          'web_search="disabled"',
          "--json",
          "--output-schema",
          join(dir, "schema.json"),
          "--output-last-message",
          join(dir, "output.json"),
        ];
        for (const feature of [
          "shell_tool",
          "unified_exec",
          "shell_snapshot",
          "apps",
          "plugins",
          "hooks",
          "memories",
          "chronicle",
          "multi_agent",
          "multi_agent_v2",
          "browser_use",
          "computer_use",
          "image_generation",
          "view_image",
          "skill_search",
        ])
          args.push("--disable", feature);
        args.push("-");
        prompt = `${this.prompts.extraction}\n${JSON.stringify(input)}`;
      } else {
        args = [
          "-p",
          "--model",
          model,
          "--safe-mode",
          "--setting-sources",
          "",
          "--permission-mode",
          "dontAsk",
          "--tools",
          "",
          "--no-session-persistence",
          "--system-prompt",
          this.prompts.verification,
          "--output-format",
          "json",
          "--json-schema",
          schema,
        ];
        prompt = `Output must conform exactly to this JSON Schema (use verdict, not decision; use only listed reasonCode values):\n${schema}\nInput evidence:\n${JSON.stringify(input)}`;
      }
      const raw = await this.runner(
        kind === "spark" ? "codex" : "claude",
        args,
        prompt,
        dir,
        signal,
      );
      if (kind === "spark") {
        if ((await stat(join(dir, "output.json"))).size > 65536)
          throw new CodeMemoryError("MEMORY_OUTPUT_LIMIT", "Structured output exceeds 64 KiB");
        const events = raw
          .trim()
          .split("\n")
          .filter(Boolean)
          .map((line) => JSON.parse(line));
        if (
          events.some((e) => e.type === "turn.failed" || e.type === "error") ||
          !events.some((e) => e.type === "turn.completed")
        )
          throw new CodeMemoryError("MEMORY_PROVIDER_PROTOCOL", "Incomplete Codex turn");
        const models = events
          .flatMap((e) => [e.model, e.item?.model])
          .filter((x): x is string => typeof x === "string");
        if (models.some((x) => x !== model))
          throw new CodeMemoryError("MEMORY_MODEL_MISMATCH", "Unexpected model reported");
        return {
          output: JSON.parse(await readFile(join(dir, "output.json"), "utf8")),
          metrics: {
            requestedModel: model,
            reportedModel: models[0] ?? null,
            modelVerified: models.length > 0,
            elapsedMs: Date.now() - started,
            usage: events.find((e) => e.type === "turn.completed")?.usage ?? null,
          },
        };
      }
      const result = JSON.parse(raw);
      const models = Object.keys(result.modelUsage ?? {});
      if (result.is_error)
        throw new CodeMemoryError(
          "MEMORY_PROVIDER_PROTOCOL",
          "Verifier returned an unsuccessful result",
        );
      // Some CLI versions return JSON text instead of invoking their internal formatter.
      // Accept it only through the same strict runtime schema, without renaming fields.
      let output = result.structured_output;
      const outputFormat = output ? "structured_output" : "validated_json_text";
      if (!output && typeof result.result === "string") {
        const text = result.result.trim().replace(/^```json\s*([\s\S]*?)\s*```$/, "$1");
        try {
          output = JSON.parse(text);
        } catch {
          throw new CodeMemoryError(
            "MEMORY_VERIFICATION_SCHEMA",
            "Verifier did not return valid protocol JSON",
          );
        }
      }
      const validated = verificationSchema.safeParse(output);
      if (!validated.success)
        throw new CodeMemoryError(
          "MEMORY_VERIFICATION_SCHEMA",
          "Verifier JSON did not match the exact protocol schema",
        );
      if (models.length !== 1 || models[0] !== model)
        throw new CodeMemoryError(
          "MEMORY_MODEL_MISMATCH",
          "Verifier model telemetry missing or outside allowlist",
        );
      return {
        output: validated.data,
        metrics: {
          requestedModel: model,
          reportedModel: model,
          outputFormat,
          modelVerified: true,
          elapsedMs: Date.now() - started,
          usage: result.modelUsage[model],
        },
      };
    } catch (error) {
      if (error instanceof CodeMemoryError) throw error;
      throw new CodeMemoryError("MEMORY_PROVIDER_PROTOCOL", "Invalid or missing model response");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
}

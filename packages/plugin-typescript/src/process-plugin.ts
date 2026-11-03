import { spawn } from "node:child_process";
import { homedir } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { Analysis, IndexedFile, ProjectContext } from "@codememory/core";
import { CodeMemoryError } from "@codememory/core";
import { type ParserProfileEvent, TypeScriptPlugin } from "./index";

const STDERR_TAIL_BYTES = 8 * 1024;
const escapeRegExp = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
/** Replace `prefix` only where it ends at a path boundary, so /a/proj leaves /a/project2 alone. */
function replacePathPrefix(text: string, prefix: string, replacement: string) {
  const pattern = new RegExp(`${escapeRegExp(prefix)}(?=[/\\\\]|$|[\\s:'"()\\[\\]])`, "g");
  return text.replace(pattern, replacement);
}
/**
 * Redact absolute paths in parser stderr: paths under the project root become root-relative
 * (the bare root becomes `.`), the home directory becomes `~`, and any other absolute (POSIX or
 * Windows) directory chain collapses to `…/` plus the basename.
 */
export function redactStderrPaths(input: string, root?: string, home = homedir()) {
  let text = input;
  const projectRoot = root?.replace(/[/\\]+$/, "");
  if (projectRoot) {
    text = text.replace(new RegExp(`${escapeRegExp(projectRoot)}[/\\\\]`, "g"), "");
    text = replacePathPrefix(text, projectRoot, ".");
  }
  if (home && home !== "/") text = replacePathPrefix(text, home.replace(/[/\\]+$/, ""), "~");
  return text.replace(/(?<![\w.~-])(?:[A-Za-z]:)?[\\/](?:[^\s:'"()\\/]+[\\/])+/g, "…/");
}
/** Sanitize the stderr tail: drop control characters and redact absolute paths. */
function stderrTail(buffer: Buffer, root?: string) {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are stripped deliberately.
  const text = buffer.toString("utf8").replace(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f]/g, "");
  return redactStderrPaths(text, root).replace(/\s+/g, " ").trim();
}
/** One parser subprocess per index job keeps MCP initialization/status responsive. */
export class ProcessTypeScriptPlugin extends TypeScriptPlugin {
  override async analyze(
    context: ProjectContext,
    files: IndexedFile[],
    configs: Map<string, string>,
    signal?: AbortSignal,
  ): Promise<Analysis> {
    const timeoutMs = context.effectiveConfig?.parserTimeoutMs ?? 120000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000)
      throw new CodeMemoryError(
        "PARSER_ERROR",
        "Parser timeout must be between 1000 and 600000 ms",
      );
    const limit = context.effectiveConfig?.parserOutputLimitMiB ?? 4096;
    if (!Number.isInteger(limit) || limit < 1 || limit > 8192)
      throw new CodeMemoryError(
        "PARSER_ERROR",
        "Parser output limit must be between 1 and 8192 MiB",
      );
    if (signal?.aborted) throw new CodeMemoryError("INDEX_CANCELLED", "Index job cancelled");
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [
          ...(process.versions.bun ? ["--smol"] : []),
          fileURLToPath(new URL("./worker.ts", import.meta.url)),
        ],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const analysis: Analysis = { symbols: [], edges: [], unresolved: [], diagnostics: [] };
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let complete = false;
      let bytes = 0;
      let failed = false;
      // Keep only the tail of stderr so a crash can be diagnosed without unbounded buffering.
      let stderr = Buffer.alloc(0);
      const onAbort = () => fail("Parser worker cancelled", "INDEX_CANCELLED");
      const fail = (reason: string, code = "PARSER_ERROR") => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        signal?.removeEventListener("abort", onAbort);
        pending = "";
        for (const records of Object.values(analysis)) records.length = 0;
        // A failed isolated parser has no state to flush. Ensure it cannot keep
        // consuming resources after the indexing job has already failed.
        child.kill("SIGKILL");
        reject(new CodeMemoryError(code, reason));
      };
      const timer = setTimeout(
        () => fail(`Parser worker timed out after ${timeoutMs} ms`),
        timeoutMs,
      );
      child.once("error", () => fail("Parser worker could not start"));
      child.stdin.on("error", () => fail("Parser worker input stream failed"));
      signal?.addEventListener("abort", onAbort, { once: true });
      child.stderr.on("data", (chunk: Buffer) => {
        stderr = Buffer.concat([stderr, chunk]);
        if (stderr.length > STDERR_TAIL_BYTES) stderr = stderr.subarray(-STDERR_TAIL_BYTES);
      });
      child.stdout.on("data", (chunk: Buffer) => {
        if (failed) return;
        bytes += chunk.length;
        if (bytes > limit * 1024 * 1024) {
          fail(
            `Parser worker exceeded the ${limit} MiB output limit; increase parserOutputLimitMiB in .codememory/config.json and restart the MCP session`,
          );
          return;
        }
        pending += decoder.write(chunk);
        try {
          while (pending.includes("\n")) {
            const newline = pending.indexOf("\n");
            if (newline > 64 * 1024 * 1024) throw new Error("Oversized record");
            const line = pending.slice(0, newline);
            pending = pending.slice(newline + 1);
            if (complete) throw new Error("Output after completion");
            const record = JSON.parse(line);
            if (record.type === "progress") {
              if (
                !record.value ||
                ![
                  "WORKSPACE",
                  "DECLARATIONS",
                  "PROGRAM",
                  "CHECKER",
                  "SEMANTIC_FILE",
                  "DEDUPLICATION",
                  "COMPLETE",
                ].includes(record.value.phase)
              )
                throw new Error("Invalid progress");
              this.profile?.(record.value as ParserProfileEvent);
            } else if (record.type === "complete") complete = true;
            else if (
              Object.hasOwn(analysis, record.type) &&
              record.value &&
              typeof record.value === "object" &&
              !Array.isArray(record.value)
            )
              (analysis[record.type as keyof Analysis] as object[]).push(record.value);
            else throw new Error("Invalid record");
          }
          if (pending.length > 64 * 1024 * 1024) throw new Error("Oversized record");
        } catch {
          fail("Parser worker returned invalid or oversized JSON records");
        }
      });
      child.once("close", (code, exitSignal) => {
        clearTimeout(timer);
        if (failed) return;
        if (code !== 0) {
          const detail = stderrTail(stderr, context.canonicalRoot);
          fail(
            `Parser worker exited unsuccessfully (code ${code}, signal ${exitSignal ?? "none"})${detail ? `: ${detail}` : ""}`,
          );
          return;
        }
        try {
          if (!complete || pending || decoder.end()) throw new Error("Incomplete output");
          signal?.removeEventListener("abort", onAbort);
          resolve(analysis);
        } catch {
          fail("Parser worker returned invalid JSON");
        }
      });
      child.stdin.end(
        JSON.stringify({ context, files, configs: [...configs], progress: !!this.profile }),
      );
    });
  }
}

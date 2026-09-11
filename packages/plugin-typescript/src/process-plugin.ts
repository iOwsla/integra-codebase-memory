import { spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { fileURLToPath } from "node:url";
import type { Analysis, IndexedFile, ProjectContext } from "@codememory/core";
import { CodeMemoryError } from "@codememory/core";
import { TypeScriptPlugin } from "./index";
/** One parser subprocess per index job keeps MCP initialization/status responsive. */
export class ProcessTypeScriptPlugin extends TypeScriptPlugin {
  override async analyze(
    context: ProjectContext,
    files: IndexedFile[],
    configs: Map<string, string>,
  ): Promise<Analysis> {
    const timeoutMs = context.effectiveConfig?.parserTimeoutMs ?? 120000;
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1000 || timeoutMs > 600000)
      throw new CodeMemoryError(
        "PARSER_ERROR",
        "Parser timeout must be between 1000 and 600000 ms",
      );
    const limit = context.effectiveConfig?.parserOutputLimitMiB ?? 1024;
    if (!Number.isInteger(limit) || limit < 1 || limit > 8192)
      throw new CodeMemoryError(
        "PARSER_ERROR",
        "Parser output limit must be between 1 and 8192 MiB",
      );
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./worker.ts", import.meta.url))],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const analysis: Analysis = { symbols: [], edges: [], unresolved: [], diagnostics: [] };
      const decoder = new StringDecoder("utf8");
      let pending = "";
      let complete = false;
      let bytes = 0;
      let failed = false;
      const fail = (reason: string) => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        pending = "";
        for (const records of Object.values(analysis)) records.length = 0;
        // A failed isolated parser has no state to flush. Ensure it cannot keep
        // consuming resources after the indexing job has already failed.
        child.kill("SIGKILL");
        reject(new CodeMemoryError("PARSER_ERROR", reason));
      };
      const timer = setTimeout(
        () => fail(`Parser worker timed out after ${timeoutMs} ms`),
        timeoutMs,
      );
      child.once("error", () => fail("Parser worker could not start"));
      child.stdin.on("error", () => fail("Parser worker input stream failed"));
      child.stderr.resume();
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
            if (record.type === "complete") complete = true;
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
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (failed) return;
        if (code !== 0) {
          fail(`Parser worker exited unsuccessfully (code ${code}, signal ${signal ?? "none"})`);
          return;
        }
        try {
          if (!complete || pending || decoder.end()) throw new Error("Incomplete output");
          resolve(analysis);
        } catch {
          fail("Parser worker returned invalid JSON");
        }
      });
      child.stdin.end(JSON.stringify({ context, files, configs: [...configs] }));
    });
  }
}

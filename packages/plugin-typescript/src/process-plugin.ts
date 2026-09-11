import { spawn } from "node:child_process";
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
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./worker.ts", import.meta.url))],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const output: Buffer[] = [];
      let bytes = 0;
      let failed = false;
      const fail = (reason: string) => {
        if (failed) return;
        failed = true;
        clearTimeout(timer);
        output.length = 0;
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
        if (bytes > 256 * 1024 * 1024) fail("Parser worker exceeded the 256 MiB output limit");
        else output.push(chunk);
      });
      child.once("close", (code, signal) => {
        clearTimeout(timer);
        if (failed) return;
        if (code !== 0) {
          fail(`Parser worker exited unsuccessfully (code ${code}, signal ${signal ?? "none"})`);
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(output).toString()) as Analysis);
        } catch {
          fail("Parser worker returned invalid JSON");
        }
      });
      child.stdin.end(JSON.stringify({ context, files, configs: [...configs] }));
    });
  }
}

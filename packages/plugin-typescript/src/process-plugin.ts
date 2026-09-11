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
    return new Promise((resolve, reject) => {
      const child = spawn(
        process.execPath,
        [fileURLToPath(new URL("./worker.ts", import.meta.url))],
        { stdio: ["pipe", "pipe", "pipe"] },
      );
      const output: Buffer[] = [];
      let bytes = 0;
      let failed = false;
      const fail = () => {
        if (failed) return;
        failed = true;
        child.kill();
        reject(
          new CodeMemoryError("PARSER_ERROR", "Parser worker failed or exceeded output limit"),
        );
      };
      const timer = setTimeout(fail, 120000);
      child.once("error", fail);
      child.stdin.on("error", fail);
      child.stderr.resume();
      child.stdout.on("data", (chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > 256 * 1024 * 1024) fail();
        else output.push(chunk);
      });
      child.once("close", (code) => {
        clearTimeout(timer);
        if (failed) return;
        if (code !== 0) {
          fail();
          return;
        }
        try {
          resolve(JSON.parse(Buffer.concat(output).toString()) as Analysis);
        } catch {
          fail();
        }
      });
      child.stdin.end(JSON.stringify({ context, files, configs: [...configs] }));
    });
  }
}

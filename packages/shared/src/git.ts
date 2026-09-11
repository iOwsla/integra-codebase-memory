import { execFile } from "node:child_process";
import { promisify } from "node:util";
import type { GitProvider } from "@codememory/core";

const execute = promisify(execFile);
/** Read-only Git metadata. Never changes the selected source root. */
export class GitCli implements GitProvider {
  private async command(root: string, args: string[]) {
    return (
      await execute("git", ["-C", root, ...args], {
        timeout: 5000,
        maxBuffer: 1024 * 1024,
        env: { ...process.env, GIT_OPTIONAL_LOCKS: "0" },
      })
    ).stdout.trim();
  }
  async inspect(root: string) {
    return {
      branch: await this.command(root, ["symbolic-ref", "--short", "HEAD"]).catch(() => null),
      head: await this.command(root, ["rev-parse", "HEAD"]).catch(() => null),
    };
  }
  async changed(root: string) {
    return this.command(root, [
      "status",
      "--porcelain=v1",
      "-z",
      "--untracked-files=all",
      "--",
      ".",
    ]);
  }
}

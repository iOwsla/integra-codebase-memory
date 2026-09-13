import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { CodeMemoryError, type GitProvider } from "@codememory/core";

export interface GitChange {
  kind: string;
  oldPath: string | null;
  newPath: string | null;
  oldObjectId: string | null;
  newObjectId: string | null;
  oldMode: string;
  newMode: string;
}
/** Read-only object operations. Never uses worktree diff filters, shell or external helpers. */
export class GitCli implements GitProvider {
  async command(root: string, args: string[], maxBuffer = 8 * 1024 * 1024) {
    try {
      const execute = promisify(execFile);
      const env = Object.fromEntries(
        Object.entries(process.env).filter(([k]) => !k.startsWith("GIT_")),
      );
      return (
        await execute(
          "git",
          [
            "--no-replace-objects",
            "-c",
            "core.fsmonitor=false",
            "-c",
            "core.quotePath=false",
            "-C",
            root,
            ...args,
          ],
          {
            timeout: 15000,
            maxBuffer,
            encoding: "buffer",
            windowsHide: true,
            env: {
              ...env,
              GIT_OPTIONAL_LOCKS: "0",
              GIT_TERMINAL_PROMPT: "0",
              GIT_CONFIG_NOSYSTEM: "1",
              GIT_CONFIG_GLOBAL: process.platform === "win32" ? "NUL" : "/dev/null",
              GIT_NO_LAZY_FETCH: "1",
            },
          },
        )
      ).stdout;
    } catch (error) {
      const e = error as { code?: string | number; killed?: boolean };
      throw new CodeMemoryError(
        e.code === 1
          ? "GIT_NEGATIVE_RESULT"
          : e.code === "ENOENT"
            ? "GIT_UNAVAILABLE"
            : e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER"
              ? "GIT_OUTPUT_LIMIT"
              : e.killed
                ? "GIT_TIMEOUT"
                : "GIT_READ_FAILED",
        "Git read failed; check selected repository, object availability and collection limits. Raw output omitted.",
      );
    }
  }
  private async text(root: string, args: string[]) {
    return new TextDecoder("utf-8", { fatal: true }).decode(await this.command(root, args)).trim();
  }
  async inspect(root: string) {
    const gitDir = await this.text(root, ["rev-parse", "--absolute-git-dir"]).catch((e) => {
      if (e.code === "GIT_UNAVAILABLE") throw e;
      return null;
    });
    if (!gitDir)
      return {
        branch: null,
        head: null,
        gitDir: null,
        commonDir: null,
        objectFormat: null,
        shallow: false,
      };
    const commonDir = await this.text(root, [
      "rev-parse",
      "--path-format=absolute",
      "--git-common-dir",
    ]);
    const objectFormat = await this.text(root, ["rev-parse", "--show-object-format"]);
    if (!["sha1", "sha256"].includes(objectFormat))
      throw new CodeMemoryError("GIT_OBJECT_FORMAT", "Unsupported Git object format");
    return {
      branch: await this.text(root, ["symbolic-ref", "--short", "HEAD"]).catch(() => null),
      head: await this.text(root, ["rev-parse", "--verify", "HEAD^{commit}"]).catch(() => null),
      gitDir,
      commonDir,
      objectFormat,
      shallow: (await this.text(root, ["rev-parse", "--is-shallow-repository"])) === "true",
    };
  }
  private object(value: string) {
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(value))
      throw new CodeMemoryError("INVALID_ARGUMENT", "Expected a full Git object ID");
    return value;
  }
  async commits(root: string, head: string, offset: number, limit: number, excludeHead?: string) {
    const result = await this.text(root, [
      "rev-list",
      "--topo-order",
      `--skip=${offset}`,
      `--max-count=${limit}`,
      this.object(head),
      ...(excludeHead ? ["--not", this.object(excludeHead)] : []),
      "--",
    ]);
    return result ? result.split("\n") : [];
  }
  async commit(root: string, object: string) {
    const raw = await this.text(root, [
      "show",
      "-s",
      "--no-show-signature",
      "--format=%T%x00%P%x00%ct%x00%s",
      this.object(object),
      "--",
    ]);
    const [tree, parents, timestamp, subject] = raw.split("\0");
    return {
      tree: tree ?? "",
      parents: parents ? parents.split(" ") : [],
      committedAt: new Date(Number(timestamp) * 1000).toISOString(),
      subject: (subject ?? "").slice(0, 500),
      subjectAuthority: "UNTRUSTED_METADATA",
    };
  }
  async changes(root: string, commit: string, parent?: string): Promise<GitChange[]> {
    const args = [
      "diff-tree",
      "--no-commit-id",
      "--no-ext-diff",
      "--no-textconv",
      "--no-abbrev",
      "--raw",
      "-r",
      "-z",
      "-M",
      "-l1000",
    ];
    if (parent) args.push(this.object(parent), this.object(commit));
    else args.push("--root", this.object(commit));
    args.push("--");
    const tokens = new TextDecoder("utf-8", { fatal: true })
      .decode(await this.command(root, args))
      .split("\0");
    const results: GitChange[] = [];
    for (let i = 0; i < tokens.length - 1; ) {
      const metadata = tokens[i++];
      if (!metadata) continue;
      const match = /^:(\d+) (\d+) ([0-9a-f]+) ([0-9a-f]+) ([A-Z])\d*$/.exec(metadata);
      if (!match) throw new CodeMemoryError("GIT_PROTOCOL", "Unexpected raw Git change format");
      const path = tokens[i++];
      const other = match[5] === "R" || match[5] === "C" ? tokens[i++] : path;
      if (path === undefined || other === undefined)
        throw new CodeMemoryError("GIT_PROTOCOL", "Missing Git path");
      const nullable = (s: string | undefined) => (s && !/^0+$/.test(s) ? s : null);
      results.push({
        kind: match[5] ?? "",
        oldPath: match[5] === "A" ? null : path,
        newPath: match[5] === "D" ? null : other,
        oldObjectId: nullable(match[3]),
        newObjectId: nullable(match[4]),
        oldMode: match[1] ?? "",
        newMode: match[2] ?? "",
      });
    }
    return results;
  }
  async blob(root: string, object: string, maxBytes = 2 * 1024 * 1024) {
    const value = this.object(object);
    const size = Number(await this.text(root, ["cat-file", "-s", value]));
    if (!Number.isSafeInteger(size) || size > maxBytes)
      throw new CodeMemoryError("SKIPPED_TOO_LARGE", "Git blob exceeds source budget");
    return this.command(root, ["cat-file", "blob", value], maxBytes + 1);
  }
  async index(root: string) {
    return this.command(root, ["ls-files", "--stage", "-z"]);
  }
  async tree(root: string, head: string) {
    return this.command(root, ["ls-tree", "-r", "-z", this.object(head)]);
  }
  async reachable(root: string, commit: string, head: string) {
    try {
      await this.command(root, [
        "merge-base",
        "--is-ancestor",
        this.object(commit),
        this.object(head),
      ]);
      return true;
    } catch (e) {
      return e instanceof CodeMemoryError && e.code === "GIT_NEGATIVE_RESULT" ? false : null;
    }
  }
}

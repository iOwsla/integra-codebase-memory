import type { Dirent } from "node:fs";
import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import {
  CodeMemoryError,
  type ConfigurationReferences,
  type ExclusionSummary,
  type FileScanner,
  type IndexedFile,
  type ProjectContext,
} from "@codememory/core";
import { forbidden, hash, id, safePath, slash } from "@codememory/shared";
import ignore, { type Ignore } from "ignore";
import picomatch from "picomatch";
export type ScanObserver = (event: "scan" | "hash" | "read", path: string) => void;
const errorCode = (error: unknown) =>
  error && typeof error === "object" && "code" in error ? String(error.code) : "";
/** A file that disappeared between listing and reading (installs, branch switches). */
const vanished = (error: unknown) => ["NOT_FOUND", "ENOENT"].includes(errorCode(error));
/**
 * Source files may legitimately contain a NUL inside a string literal. Treat a file as
 * binary only when it carries a UTF-16 BOM, when NULs exceed 10% of the first 8 KiB, or
 * when it contains a NUL and is not valid UTF-8.
 */
function isBinary(data: Buffer) {
  if ((data[0] === 0xff && data[1] === 0xfe) || (data[0] === 0xfe && data[1] === 0xff)) return true;
  if (!data.includes(0)) return false;
  const sample = data.subarray(0, 8192);
  let nul = 0;
  for (const byte of sample) if (byte === 0) nul++;
  if (nul > sample.length * 0.1) return true;
  try {
    new TextDecoder("utf-8", { fatal: true }).decode(data);
    return false;
  } catch {
    return true;
  }
}
export class RepositoryScanner implements FileScanner {
  constructor(private readonly observe: ScanObserver = () => {}) {}
  async discover(context: ProjectContext, visit: (path: string) => Promise<void>) {
    return this.scan(context, undefined, visit);
  }
  async scan(
    context: ProjectContext,
    references?: ConfigurationReferences,
    visit?: (path: string) => Promise<void>,
  ) {
    const jsonCandidates = new Map<string, string>();
    const files: IndexedFile[] = [];
    const configs = new Map<string, string>();
    let excluded = 0;
    const diagnostics: { reason: string; path: string; message: string }[] = [];
    const exclusions: ExclusionSummary & { diagnostics?: typeof diagnostics } = {
      files: 0,
      directories: 0,
      other: 0,
      byReason: {},
    };
    const exclude = (kind: "files" | "directories" | "other", reason: string) => {
      excluded++;
      exclusions[kind]++;
      exclusions.byReason[reason] ??= { files: 0, directories: 0, other: 0 };
      const counts = exclusions.byReason[reason];
      counts[kind]++;
    };
    const matchesExclude = picomatch([...context.effectiveConfig.exclude]);
    const matchesInclude = context.effectiveConfig.include.length
      ? picomatch([...context.effectiveConfig.include])
      : () => true;
    const walk = async (
      dir: string,
      parents: { base: string; rules: Ignore; reason: string }[],
    ) => {
      this.observe("scan", dir);
      const rules = [...parents];
      for (const ignoreName of [
        ".gitignore",
        ...(dir === context.canonicalRoot ? [".codememoryignore"] : []),
      ]) {
        const ignorePath = resolve(dir, ignoreName),
          rel = slash(relative(context.canonicalRoot, ignorePath));
        let outOfScope = false;
        try {
          // A symlinked ignore file resolves elsewhere, so safePath re-runs the full
          // nested-repository walk on its target instead of trusting the walked ancestors.
          const p = await safePath(context, ignorePath, { ancestorsVetted: true });
          const s = await lstat(p);
          if (s.size <= 65536) {
            const text = await readFile(p, "utf8");
            configs.set(rel, text);
            rules.push({
              base: dir,
              rules: ignore().add(text),
              reason: ignoreName === ".gitignore" ? "GITIGNORE" : "CODEMEMORYIGNORE",
            });
          }
        } catch (e) {
          if (errorCode(e) === "PATH_OUT_OF_SCOPE") outOfScope = true;
          else if (!vanished(e)) throw e;
          else {
            // Only a missing entry is absent; a dangling or unresolvable link is not. If
            // lstat itself fails (no search permission on dir), no entry below can be read
            // either and readdir or the file reads report it.
            const absent = await lstat(ignorePath).then(
              () => false,
              () => true,
            );
            if (absent) continue;
            outOfScope = true;
          }
        }
        if (!outOfScope) continue;
        // .codememoryignore is this tool's privacy control: never index without it.
        if (ignoreName === ".codememoryignore")
          throw new CodeMemoryError(
            "IGNORE_FILE_OUT_OF_SCOPE",
            `Ignore file ${rel} links outside the project`,
          );
        // Git does not follow a symlinked .gitignore either, so its rules are not applied.
        // Nothing outside the scope is read; the gap is reported instead. Read errors on a
        // real in-tree ignore file (EACCES, EIO) stay fatal.
        exclude("other", "IGNORE_FILE_OUT_OF_SCOPE");
        if (diagnostics.length < 20)
          diagnostics.push({
            reason: "IGNORE_FILE_OUT_OF_SCOPE",
            path: rel,
            message: `Ignore file ${rel} links outside the project; its rules were not applied (git also ignores a symlinked .gitignore)`,
          });
      }
      let entries: Dirent[];
      try {
        entries = await readdir(dir, { withFileTypes: true });
      } catch (error) {
        if (dir === context.canonicalRoot) throw error;
        const code = errorCode(error);
        // Removed between the parent listing and this recursion: nothing to index.
        if (code === "ENOENT" || code === "ENOTDIR") return;
        // Fail the run rather than publishing every file below this directory as deleted.
        if (["EACCES", "EPERM", "EIO"].includes(code))
          throw new CodeMemoryError(
            "SCAN_UNREADABLE_DIRECTORY",
            `Cannot read directory ${slash(relative(context.canonicalRoot, dir))} (${code})`,
          );
        throw error;
      }
      for (const entry of entries.sort((a, b) =>
        a.name < b.name ? -1 : a.name > b.name ? 1 : 0,
      )) {
        const path = resolve(dir, entry.name),
          rel = slash(relative(context.canonicalRoot, path));
        const exclusionReason = forbidden(rel)
          ? "PROTECTED_PATH"
          : entry.isSymbolicLink()
            ? "SYMLINK"
            : matchesExclude(rel) || matchesExclude(`${rel}/`)
              ? "CONFIG_EXCLUDE"
              : rules.find((r) =>
                  r.rules.ignores(slash(relative(r.base, path)) + (entry.isDirectory() ? "/" : "")),
                )?.reason;
        if (exclusionReason) {
          exclude(
            entry.isDirectory() ? "directories" : entry.isFile() ? "files" : "other",
            exclusionReason,
          );
          continue;
        }
        if (entry.isDirectory()) {
          if (
            await lstat(resolve(path, ".git")).then(
              () => true,
              () => false,
            )
          ) {
            exclude("directories", "NESTED_REPOSITORY");
            continue;
          }
          await walk(path, rules);
          continue;
        }
        if (!entry.isFile()) continue;
        if (visit) {
          if (matchesInclude(rel)) await visit(rel);
          else exclude("files", "NOT_INCLUDED");
          continue;
        }
        if (entry.name.endsWith(".json")) jsonCandidates.set(path, rel);
        const config = /^(tsconfig.*\.json|jsconfig.*\.json|package\.json)$/.test(entry.name);
        const source = /\.(?:[cm]?[jt]sx?|prisma)$/.test(entry.name);
        if (!source && !config) continue;
        if (!config && !matchesInclude(rel)) {
          exclude("files", "NOT_INCLUDED");
          continue;
        }
        if (config) {
          try {
            const actual = await safePath(context, path, { ancestorsVetted: true }),
              info = await lstat(actual);
            if (info.size <= 65536) {
              this.observe("read", actual);
              configs.set(rel, await readFile(actual, "utf8"));
            }
          } catch (error) {
            if (!vanished(error)) throw error;
            exclude("files", "CONFIG_VANISHED");
          }
          continue;
        }
        try {
          const actual = await safePath(context, path, { ancestorsVetted: true }),
            info = await lstat(actual);
          let status: IndexedFile["status"] = "INDEXED",
            content = "",
            contentHash = "";
          if (info.size > context.effectiveConfig.maxFileSizeBytes) {
            status = "SKIPPED_TOO_LARGE";
          } else {
            this.observe("read", actual);
            const data = await readFile(actual);
            if (isBinary(data)) {
              status = "SKIPPED_BINARY";
            } else {
              // PostgreSQL text/jsonb rejects U+0000; a space keeps every offset valid.
              content = data.toString("utf8").replaceAll("\0", " ");
              this.observe("hash", actual);
              contentHash = hash(data);
            }
          }
          const generated =
            /(^|\/)(__generated__|generated)(\/|$)|\.generated\./.test(rel) ||
            /@generated|DO NOT EDIT|auto-generated/i.test(content.slice(0, 1024));
          if (generated && context.effectiveConfig.excludeGenerated) {
            exclude("files", "GENERATED");
            continue;
          }
          if (status !== "INDEXED") exclude("files", status);
          files.push({
            id: id(context.projectScopeId, rel),
            path: rel,
            language: extname(rel).slice(1),
            size: info.size,
            modifiedAt: info.mtime.toISOString(),
            generated,
            status,
            content,
            hash: contentHash,
            parserVersion: context.indexVersion,
          });
        } catch (error) {
          const code = errorCode(error);
          if (!["EACCES", "EPERM", "ENOENT", "NOT_FOUND", "EIO", "EBUSY"].includes(code))
            throw error;
          files.push({
            id: id(context.projectScopeId, rel),
            path: rel,
            language: extname(rel).slice(1),
            size: 0,
            modifiedAt: new Date(0).toISOString(),
            generated: false,
            status: "INDEX_ERROR",
            content: "",
            hash: "",
            parserVersion: context.indexVersion,
            error: code,
          });
        }
      }
    };
    await walk(context.canonicalRoot, []);
    if (diagnostics.length) exclusions.diagnostics = diagnostics;
    // The language plugin proposes metadata paths; only already-discovered, eligible
    // in-scope JSON files can be read. References never trigger directory traversal.
    const visited = new Set<string>();
    const queue = [...configs.keys()];
    while (references && queue.length) {
      const rel = queue.shift() as string;
      if (visited.has(rel)) continue;
      visited.add(rel);
      for (const candidate of references(
        resolve(context.canonicalRoot, rel),
        configs.get(rel) ?? "",
      )) {
        const next = jsonCandidates.get(resolve(candidate));
        if (!next || visited.has(next)) continue;
        if (!configs.has(next)) {
          try {
            const actual = await safePath(context, next);
            const info = await lstat(actual);
            if (info.size > 65536) continue;
            this.observe("read", actual);
            configs.set(next, await readFile(actual, "utf8"));
          } catch (error) {
            if (!vanished(error)) throw error;
            exclude("files", "CONFIG_VANISHED");
            continue;
          }
        }
        queue.push(next);
      }
    }
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, configs, excluded, exclusions };
  }
}

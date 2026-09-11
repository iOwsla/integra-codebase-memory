import { lstat, readdir, readFile } from "node:fs/promises";
import { extname, relative, resolve } from "node:path";
import type { FileScanner, IndexedFile, ProjectContext } from "@codememory/core";
import { forbidden, hash, id, safePath, slash } from "@codememory/shared";
import ignore, { type Ignore } from "ignore";
import picomatch from "picomatch";
export type ScanObserver = (event: "scan" | "hash" | "read", path: string) => void;
export class RepositoryScanner implements FileScanner {
  constructor(private readonly observe: ScanObserver = () => {}) {}
  async scan(context: ProjectContext) {
    const files: IndexedFile[] = [];
    const configs = new Map<string, string>();
    let excluded = 0;
    const matchesExclude = picomatch([...context.effectiveConfig.exclude]);
    const matchesInclude = context.effectiveConfig.include.length
      ? picomatch([...context.effectiveConfig.include])
      : () => true;
    const walk = async (dir: string, parents: { base: string; rules: Ignore }[]) => {
      this.observe("scan", dir);
      const rules = [...parents];
      const ignorePath = resolve(dir, ".gitignore");
      try {
        const p = await safePath(context, ignorePath);
        const s = await lstat(p);
        if (s.size <= 65536) {
          const text = await readFile(p, "utf8");
          configs.set(slash(relative(context.canonicalRoot, p)), text);
          rules.push({ base: dir, rules: ignore().add(text) });
        }
      } catch (e) {
        if ((e as { code?: string }).code !== "NOT_FOUND") throw e;
      }
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        const path = resolve(dir, entry.name),
          rel = slash(relative(context.canonicalRoot, path));
        if (
          forbidden(rel) ||
          entry.isSymbolicLink() ||
          matchesExclude(rel) ||
          matchesExclude(`${rel}/`) ||
          rules.some((r) =>
            r.rules.ignores(slash(relative(r.base, path)) + (entry.isDirectory() ? "/" : "")),
          )
        ) {
          excluded++;
          continue;
        }
        if (entry.isDirectory()) {
          if (
            await lstat(resolve(path, ".git")).then(
              () => true,
              () => false,
            )
          ) {
            excluded++;
            continue;
          }
          await walk(path, rules);
          continue;
        }
        if (!entry.isFile()) continue;
        const config = /^(tsconfig.*\.json|jsconfig.*\.json|package\.json)$/.test(entry.name);
        const source = /\.(?:[cm]?[jt]sx?)$/.test(entry.name);
        if (!source && !config) continue;
        if (!config && !matchesInclude(rel)) {
          excluded++;
          continue;
        }
        const actual = await safePath(context, path);
        const info = await lstat(actual);
        if (config) {
          if (info.size <= 65536) configs.set(rel, await readFile(actual, "utf8"));
          continue;
        }
        let status: IndexedFile["status"] = "INDEXED",
          content = "",
          contentHash = "";
        if (info.size > context.effectiveConfig.maxFileSizeBytes) {
          status = "SKIPPED_TOO_LARGE";
          excluded++;
        } else {
          this.observe("read", actual);
          const data = await readFile(actual);
          if (data.includes(0)) {
            status = "SKIPPED_BINARY";
            excluded++;
          } else {
            content = data.toString("utf8");
            this.observe("hash", actual);
            contentHash = hash(data);
          }
        }
        const generated =
          /(^|\/)(__generated__|generated)(\/|$)|\.generated\./.test(rel) ||
          /@generated|DO NOT EDIT|auto-generated/i.test(content.slice(0, 1024));
        if (generated && context.effectiveConfig.excludeGenerated) {
          excluded++;
          continue;
        }
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
      }
    };
    await walk(context.canonicalRoot, []);
    files.sort((a, b) => a.path.localeCompare(b.path));
    return { files, configs, excluded };
  }
}

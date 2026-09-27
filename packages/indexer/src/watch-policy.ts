import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { ProjectContext } from "@codememory/core";
import { contains, forbidden, slash } from "@codememory/shared";
import ignore from "ignore";
import picomatch from "picomatch";
/** Chokidar pruning callback: never descend into excluded directories. */
export function watchPolicy(context: ProjectContext) {
  const exclude = picomatch([...context.effectiveConfig.exclude]);
  const ruleCache = new Map<
    string,
    { mtimeMs: number; ctimeMs: number; size: number; rules: ReturnType<typeof ignore> }
  >();
  const rulesFor = (file: string) => {
    try {
      const stat = lstatSync(file);
      if (stat.isSymbolicLink() || stat.size > 65536) return;
      const cached = ruleCache.get(file);
      if (
        cached &&
        cached.mtimeMs === stat.mtimeMs &&
        cached.ctimeMs === stat.ctimeMs &&
        cached.size === stat.size
      )
        return cached.rules;
      const rules = ignore().add(readFileSync(file, "utf8"));
      ruleCache.set(file, { mtimeMs: stat.mtimeMs, ctimeMs: stat.ctimeMs, size: stat.size, rules });
      return rules;
    } catch {
      ruleCache.delete(file);
      return;
    }
  };
  return (candidate: string) => {
    const path = resolve(candidate),
      root = context.canonicalRoot;
    if (!contains(root, path)) return true;
    if (path === root) return false;
    const rel = slash(relative(root, path));
    if (forbidden(rel) || exclude(rel) || exclude(`${rel}/`)) return true;
    let directory = false;
    try {
      directory = lstatSync(path).isDirectory();
    } catch {
      /* Removed paths still need reconciliation. */
    }
    let current = path;
    while (contains(root, current) && current !== root) {
      try {
        const stat = lstatSync(current);
        if (stat.isSymbolicLink()) return true;
        if (stat.isDirectory() && existsSync(resolve(current, ".git"))) return true;
      } catch {
        /* Removed paths still need reconciliation. */
      }
      current = dirname(current);
    }
    current = dirname(path);
    while (contains(root, current)) {
      for (const ignoreName of [".gitignore", ...(current === root ? [".codememoryignore"] : [])]) {
        const rules = rulesFor(resolve(current, ignoreName));
        if (rules?.ignores(slash(relative(current, path)) + (directory ? "/" : ""))) return true;
      }
      if (current === root) break;
      current = dirname(current);
    }
    return false;
  };
}

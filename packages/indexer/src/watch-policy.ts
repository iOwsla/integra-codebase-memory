import { existsSync, lstatSync, readFileSync } from "node:fs";
import { dirname, relative, resolve } from "node:path";
import type { ProjectContext } from "@codememory/core";
import { contains, forbidden, slash } from "@codememory/shared";
import ignore from "ignore";
import picomatch from "picomatch";
/** Chokidar pruning callback: never descend into excluded directories. */
export function watchPolicy(context: ProjectContext) {
  const exclude = picomatch([...context.effectiveConfig.exclude]);
  return (candidate: string) => {
    const path = resolve(candidate),
      root = context.canonicalRoot;
    if (!contains(root, path)) return true;
    if (path === root) return false;
    const rel = slash(relative(root, path));
    if (forbidden(rel) || exclude(rel) || exclude(`${rel}/`)) return true;
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
      const gi = resolve(current, ".gitignore");
      try {
        const stat = lstatSync(gi);
        if (!stat.isSymbolicLink() && stat.size <= 65536) {
          const rules = ignore().add(readFileSync(gi, "utf8"));
          const local = slash(relative(current, path));
          let directory = false;
          try {
            directory = lstatSync(path).isDirectory();
          } catch {}
          if (rules.ignores(local + (directory ? "/" : ""))) return true;
        }
      } catch {}
      if (current === root) break;
      current = dirname(current);
    }
    return false;
  };
}

import { describe, expect, it } from "vitest";
import { redactStderrPaths } from "../../packages/plugin-typescript/src/process-plugin";

const home = "/Users/alice";
const root = "/Users/alice/work/proj";

describe("parser stderr path redaction", () => {
  it("rewrites the project root only at a path boundary", () => {
    expect(redactStderrPaths(`at f (${root}/src/x.ts:1:2)`, root, home)).toBe(
      "at f (src/x.ts:1:2)",
    );
    expect(redactStderrPaths(`cwd ${root}`, root, home)).toBe("cwd .");
    const sibling = redactStderrPaths("/a/project2/x", "/a/proj", home);
    expect(sibling).not.toContain("ject2");
    expect(sibling).not.toMatch(/^\./);
    expect(sibling).toBe("…/x");
  });

  it("replaces the home directory with ~ and keeps relative paths", () => {
    expect(redactStderrPaths(`at ${home}/.bun/install/cache/typescript/lib.js:9`, root, home)).toBe(
      "at ~/.bun/install/cache/typescript/lib.js:9",
    );
    expect(redactStderrPaths(`${home}2/secret/a.ts`, root, home)).toBe("…/a.ts");
  });

  it("collapses other absolute POSIX and Windows paths to their basename", () => {
    expect(redactStderrPaths("at g (/opt/bun/bin/bun:3)", root, home)).toBe("at g (…/bun:3)");
    expect(
      redactStderrPaths("at h (C:\\Users\\bob\\proj\\node_modules\\ts\\index.js:4)", root, home),
    ).toBe("at h (…/index.js:4)");
    expect(redactStderrPaths("Error in src/a/b.ts", root, home)).toBe("Error in src/a/b.ts");
  });
});

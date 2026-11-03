import { describe, expect, it } from "vitest";
import { matchMcp } from "../../scripts/setup/processes";

const entry = "/home/u/.local/share/integra-code-memory/cli/managed-mcp.ts";
const project = "/home/u/work/my project";
const command = (flags: string, path = project, file = entry) =>
  `/home/u/.bun/bin/bun ${file} mcp --project ${path} ${flags}`;

describe("matchMcp", () => {
  it("matches the installer command line with trailing --session-projects", () => {
    // install-project.ts and connect-codex.ts write exactly this argument order.
    expect(matchMcp(command("--auto-index --watch --session-projects"), [project], [entry])).toBe(
      true,
    );
  });
  it("accepts the flags in any order and the legacy form without --session-projects", () => {
    expect(matchMcp(command("--session-projects --auto-index --watch"), [project], [entry])).toBe(
      true,
    );
    expect(matchMcp(command("--watch --auto-index"), [project], [entry])).toBe(true);
    expect(matchMcp(command("--auto-index --watch"), [project], [entry])).toBe(true);
  });
  it("accepts a quoted bun executable", () => {
    expect(
      matchMcp(
        `"/Program Files/bun/bun.exe" ${entry} mcp --project ${project} --auto-index --watch --session-projects`,
        [project],
        [entry],
      ),
    ).toBe(true);
  });
  it("rejects unknown, repeated or missing flags", () => {
    expect(
      matchMcp(command("--auto-index --watch --session-projects --custom"), [project], [entry]),
    ).toBe(false);
    expect(matchMcp(command("--auto-index --custom --watch"), [project], [entry])).toBe(false);
    expect(matchMcp(command("--auto-index --watch --watch"), [project], [entry])).toBe(false);
    expect(matchMcp(command("--auto-index --session-projects"), [project], [entry])).toBe(false);
    expect(matchMcp(command("--watch"), [project], [entry])).toBe(false);
    expect(matchMcp(command(""), [project], [entry])).toBe(false);
  });
  it("rejects another project, entry or executable", () => {
    const flags = "--auto-index --watch --session-projects";
    expect(matchMcp(command(flags, "/home/u/work/other"), [project], [entry])).toBe(false);
    expect(matchMcp(command(flags, project, "/tmp/unrelated.ts"), [project], [entry])).toBe(false);
    expect(
      matchMcp(`/usr/bin/node ${entry} mcp --project ${project} ${flags}`, [project], [entry]),
    ).toBe(false);
  });
});

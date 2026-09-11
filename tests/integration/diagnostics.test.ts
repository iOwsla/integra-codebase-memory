import { CodebaseService } from "@codememory/application";
import { IndexService, RepositoryScanner } from "@codememory/indexer";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { createProjectContext } from "@codememory/shared";
import { fixture, testDatabase } from "@codememory/test-utils";
import { expect, it } from "vitest";

it("reports syntax locations, bounded diagnostics and distinct exclusions while retaining valid queries", async () => {
  const db = await testDatabase();
  const f = await fixture({
    ".codememory/config.json": JSON.stringify({
      exclude: [".workflow-tmp/**"],
      maxFileSizeBytes: 1024,
    }),
    ".workflow-tmp/report.mjs": "const hidden = 'schema'dan';",
    ".gitignore": "ignored/\n",
    "ignored/one.ts": "export const ignored = 1;",
    "good.ts": "export function healthy(){return 42}",
    "broken.mjs": "const text = 'schema'dan';\nconst other = 'it's broken';",
    "large.ts": " ".repeat(2048),
    "binary.ts": "\0",
  });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    await new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin()).index();
    const service = new CodebaseService(c, db.store);
    const status = await service.status({ diagnosticLimit: 1 });
    expect(status).toMatchObject({
      version: 1,
      incomplete: true,
      fileErrors: [],
      diagnosticSummary: { affectedFiles: 1, limit: 1, offset: 0, hasMore: true, nextOffset: 1 },
      exclusions: {
        available: true,
        files: 2,
        byReason: {
          CONFIG_EXCLUDE: { directories: 1, files: 0 },
          GITIGNORE: { directories: 1, files: 0 },
          SKIPPED_TOO_LARGE: { files: 1 },
          SKIPPED_BINARY: { files: 1 },
        },
      },
    });
    const first = status.last_run as {
      diagnostics: { file: string; line: number; column: number; code: number; kind: string }[];
    };
    expect(first.diagnostics).toHaveLength(1);
    expect(first.diagnostics[0]).toMatchObject({
      file: "broken.mjs",
      line: 1,
      kind: "SYNTAX_ERROR",
    });
    expect(first.diagnostics[0]?.column).toBeGreaterThan(0);
    expect(first.diagnostics[0]?.code).toBeGreaterThan(0);
    expect(status.incompleteReasons).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ reason: "SYNTAX_ERROR", files: 1, sampleFiles: ["broken.mjs"] }),
        expect.objectContaining({
          reason: "SKIPPED_TOO_LARGE",
          files: 1,
          sampleFiles: ["large.ts"],
        }),
      ]),
    );
    const second = await service.execute("codebase_status", {
      diagnosticLimit: 1,
      diagnosticOffset: 1,
    });
    expect(second.diagnosticSummary).toMatchObject({
      total: (status.diagnosticSummary as { total: number }).total,
      offset: 1,
    });
    expect((second.last_run as typeof first).diagnostics).toHaveLength(1);
    expect((second.last_run as typeof first).diagnostics[0]).not.toEqual(first.diagnostics[0]);
    const result = await service.execute("search_symbols", { query: "healthy" });
    expect(result.incomplete).toBe(true);
    expect(JSON.stringify(result)).toContain("healthy");
    await expect(service.status({ diagnosticLimit: 0 })).rejects.toThrow();
    await expect(service.status({ diagnosticOffset: -1 })).rejects.toThrow();
  } finally {
    await f.dispose();
    await db.dispose();
  }
});

it("reports an unindexed project without fabricating exclusion or diagnostic details", async () => {
  const db = await testDatabase(),
    f = await fixture({});
  try {
    const c = await createProjectContext(f.root);
    const status = await db.store.status(c);
    expect(status).toMatchObject({
      version: 0,
      incomplete: true,
      incompleteReasons: [{ reason: "NOT_INDEXED" }],
      diagnosticSummary: { total: 0, affectedFiles: 0, hasMore: false },
      exclusions: { available: false },
    });
  } finally {
    await f.dispose();
    await db.dispose();
  }
});

it("distinguishes preview truncation from index completeness and provides accurate continuation", async () => {
  const db = await testDatabase(),
    f = await fixture({
      "long.ts":
        "export function longFunction(){\n" +
        Array.from({ length: 40 }, (_, i) => `  const v${i} = ${i};`).join("\n") +
        "\nreturn 1;\n}",
      "wide.ts": `export const wide = "${"a".repeat(15000)}";`,
    });
  try {
    const c = await createProjectContext(f.root);
    await db.store.register(c);
    await new IndexService(c, db.store, new RepositoryScanner(), new TypeScriptPlugin()).index();
    const service = new CodebaseService(c, db.store);
    const result = await service.execute("get_symbol", { name: "longFunction" });
    expect(result).toMatchObject({
      incomplete: false,
      snippetTruncated: true,
      returnedStartLine: 1,
      returnedEndLine: 16,
      returnedEndLinePartial: false,
      continuation: { tool: "get_file_context", arguments: { path: "long.ts", line: 17 } },
    });
    const wide = await service.execute("get_symbol", { name: "wide" });
    expect(wide).toMatchObject({
      incomplete: false,
      snippetTruncated: true,
      returnedEndLine: 1,
      returnedEndLinePartial: true,
    });
    const context = await service.execute("get_file_context", { path: "wide.ts", line: 1 });
    expect(context).toMatchObject({
      snippetTruncated: true,
      returnedEndLine: 1,
      returnedEndLinePartial: true,
    });
    const rest = await service.execute("get_file_context", {
      path: "long.ts",
      line: 17,
      before: 0,
      after: 50,
    });
    expect(rest).toMatchObject({
      snippetTruncated: false,
      returnedStartLine: 17,
      returnedEndLine: 43,
      continuation: null,
    });
    const status = await service.status();
    expect(status).toMatchObject({
      runtime: { version: "0.1.0-alpha.18", pid: process.pid, sessionId: c.sessionId },
      lastIndexJob: { owner: { pid: process.pid, sessionId: c.sessionId }, lockActive: false },
      analysisScope: { languages: ["JavaScript", "TypeScript"] },
    });
  } finally {
    await f.dispose();
    await db.dispose();
  }
});

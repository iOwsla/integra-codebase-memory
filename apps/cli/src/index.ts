#!/usr/bin/env bun
import { execFile } from "node:child_process";
import { mkdir, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { CodebaseService } from "@codememory/application";
import { CodeMemoryError } from "@codememory/core";
import { PostgresStore } from "@codememory/database";
import { IndexService, ProjectSession, RepositoryScanner } from "@codememory/indexer";
import { runMcp } from "@codememory/mcp-server";
import { TypeScriptPlugin } from "@codememory/plugin-typescript";
import { ProcessTypeScriptPlugin } from "@codememory/plugin-typescript/process";
import { configSchema, createProjectContext, publicError } from "@codememory/shared";
import { Command } from "commander";

const cli = new Command()
  .name("codememory")
  .description("Local, explicitly project-scoped code intelligence")
  .version("0.1.0-alpha.6");
const collect = (value: string, previous: string[]) => [...previous, value];
const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
async function open(project?: string) {
  const context = await createProjectContext(project ?? process.cwd());
  const store = new PostgresStore();
  await store.register(context).catch(async (e) => {
    await store.close();
    throw e;
  });
  const indexer = new IndexService(context, store, new RepositoryScanner(), new TypeScriptPlugin());
  const service = new CodebaseService(context, store);
  return { context, store, indexer, service };
}
const scoped = (name: string, description: string) =>
  cli
    .command(name)
    .description(description)
    .option("--project <absolute-path>", "Explicit source scope; never expands to parent Git root");
for (const name of ["init", "add"])
  scoped(`${name} [path]`, "Register the selected repository").action(
    async (path: string | undefined, options: { project: string }) => {
      const root = options.project ?? (path ? resolve(path) : undefined);
      const app = await open(root);
      try {
        if (name === "init") {
          await mkdir(resolve(app.context.canonicalRoot, ".codememory"), { recursive: true });
          await writeFile(
            resolve(app.context.canonicalRoot, ".codememory/config.json"),
            `${JSON.stringify(configSchema.parse({}), null, 2)}\n`,
            { flag: "wx" },
          ).catch((e) => {
            if (e.code !== "EEXIST") throw e;
          });
        }
        print({
          root: app.context.canonicalRoot,
          scope: app.context.projectScopeId,
          next: `codememory index --project ${JSON.stringify(app.context.canonicalRoot)}`,
        });
      } finally {
        await app.store.close();
      }
    },
  );
scoped("index [path]", "Index or incrementally reconcile selected source scope")
  .option("--force", "Rebuild index for parser/config changes")
  .action(async (_path: string | undefined, options: { project: string; force?: boolean }) => {
    const app = await open(options.project ?? (_path ? resolve(_path) : undefined));
    try {
      print(await app.indexer.index(options.force));
    } finally {
      await app.store.close();
    }
  });
scoped("status", "Selected project status").action(async (options) => {
  const app = await open(options.project);
  try {
    print(await app.service.status());
  } finally {
    await app.store.close();
  }
});
scoped("doctor", "Diagnose selected project and database").action(async (options) => {
  const app = await open(options.project);
  try {
    const git = await promisify(execFile)("git", [
      "-C",
      app.context.canonicalRoot,
      "rev-parse",
      "--short",
      "HEAD",
    ]).then(
      (r) => r.stdout.trim(),
      () => null,
    );
    print({
      runtime: Bun.version,
      ...(await app.store.diagnostics()),
      git,
      parser: new TypeScriptPlugin().version,
      config: app.context.effectiveConfig,
      ...(await app.service.status()),
    });
  } finally {
    await app.store.close();
  }
});
const queryCommands = [
  ["search", "search_code"],
  ["symbol", "search_symbols"],
  ["callers", "find_callers"],
  ["callees", "find_callees"],
  ["references", "find_references"],
] as const;
for (const [command, tool] of queryCommands)
  scoped(`${command} <query>`, `Query ${tool} in the selected project`).action(
    async (query: string, options: { project: string }) => {
      const app = await open(options.project);
      try {
        print(
          await app.service.execute(
            tool,
            tool === "search_code" || tool === "search_symbols" ? { query } : { name: query },
          ),
        );
      } finally {
        await app.store.close();
      }
    },
  );
scoped("remember", "Store an explicit project memory")
  .requiredOption("--title <title>", "Memory title")
  .requiredOption("--content <content>", "Memory content")
  .option("--type <type>", "FACT, DECISION, WARNING, NOTE, CONVENTION, INCIDENT, TODO", "NOTE")
  .option("--scope <type>", "repository, directory, file or symbol", "repository")
  .option("--target <target>", "Scope path or symbol ID")
  .option("--tag <tag>", "Memory tag; repeat for multiple tags", collect, [])
  .option("--priority <number>", "Priority 0–10", Number, 0)
  .option("--supersedes <id>", "Replace an active same-project memory")
  .action(async (options) => {
    const app = await open(options.project);
    try {
      print(
        await app.service.memory.remember({
          type: options.type,
          title: options.title,
          content: options.content,
          scope: { type: options.scope, target: options.target },
          tags: options.tag,
          priority: options.priority,
          supersedes: options.supersedes,
        }),
      );
    } finally {
      await app.store.close();
    }
  });
scoped("memories [query]", "Search active project memories")
  .option("--archive <id>", "Archive a memory in this project")
  .option("--type <type>", "Match any selected type; repeat for multiple types", collect, [])
  .option("--tag <tag>", "Require this exact tag; repeat to require all tags", collect, [])
  .option("--scope <type>", "Filter repository, directory, file or symbol scopes")
  .option("--target <target>", "Exact scope path or symbol ID; requires --scope")
  .option("--include-inactive", "Include archived and superseded records")
  .option("--limit <number>", "Page size 1–100", Number, 20)
  .option("--offset <number>", "Page offset 0–100000", Number, 0)
  .action(async (query: string | undefined, options) => {
    const app = await open(options.project);
    try {
      print(
        options.archive
          ? await app.service.memory.archive(options.archive)
          : await app.service.execute("search_memory", {
              query: query ?? "",
              types: options.type,
              tags: options.tag,
              scope:
                options.scope || options.target
                  ? { type: options.scope, target: options.target }
                  : undefined,
              includeInactive: !!options.includeInactive,
              limit: options.limit,
              offset: options.offset,
            }),
      );
    } finally {
      await app.store.close();
    }
  });
for (const name of ["clean", "remove"])
  scoped(
    name,
    name === "clean"
      ? "Remove selected code index; retain memory"
      : "Remove selected project including its memory",
  )
    .option("--yes", "Confirm removal")
    .action(async (options) => {
      if (!options.yes)
        throw new CodeMemoryError(
          "CONFIRMATION_REQUIRED",
          `${name} requires --yes; ${name === "remove" ? "project memory will also be deleted" : "project memory is retained"}`,
        );
      const app = await open(options.project);
      try {
        await app.store.clean(app.context, name === "remove");
        print({ removed: true, memoryRetained: name === "clean" });
      } finally {
        await app.store.close();
      }
    });
scoped("debug <subject>", "Inspect unresolved references or effective config").action(
  async (subject: string, options: { project: string }) => {
    const app = await open(options.project);
    try {
      if (subject === "config") print(app.context.effectiveConfig);
      else if (subject === "unresolved")
        print((await app.store.snapshot(app.context)).unresolved.slice(0, 100));
      else throw new CodeMemoryError("INVALID_ARGUMENT", "Use debug config or debug unresolved");
    } finally {
      await app.store.close();
    }
  },
);
// MCP validates --project in createProjectContext before any database, scan or watcher work.
cli
  .command("mcp")
  .description("Start session-scoped MCP over STDIO")
  .option("--project <absolute-path>", "Required explicit project root")
  .option("--auto-index", "Reconcile selected project after startup")
  .option("--watch", "Watch selected project for the lifetime of this process")
  .action(async (options) => {
    const context = await createProjectContext(options.project);
    const store = new PostgresStore();
    const indexer = new IndexService(
      context,
      store,
      new RepositoryScanner(),
      new ProcessTypeScriptPlugin(),
    );
    await runMcp(
      new ProjectSession(context, store, indexer, !!options.autoIndex, !!options.watch),
      store,
    );
  });
scoped("watch [path]", "Watch selected project until SIGINT or SIGTERM").action(
  async (_path: string | undefined, options: { project: string }) => {
    const app = await open(options.project);
    const session = new ProjectSession(app.context, app.store, app.indexer, true, true);
    await session.start();
    let closing = false;
    const close = async () => {
      if (closing) return;
      closing = true;
      await session.close();
      await app.store.close();
    };
    process.once("SIGINT", () => void close());
    process.once("SIGTERM", () => void close());
  },
);
cli.parseAsync().catch((error) => {
  process.stderr.write(`${JSON.stringify(publicError(error))}\n`);
  if (process.env.CODEMEMORY_DEBUG === "1") process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});

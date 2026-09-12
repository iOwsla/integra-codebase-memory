import { readFile, stat } from "node:fs/promises";
import { resolve } from "node:path";
import type { CodebaseService } from "@codememory/application";
import { CodeMemoryError, type ProjectStore } from "@codememory/core";
import type { Command } from "commander";
export function registerMemoryCommands(
  cli: Command,
  open: (
    project?: string,
  ) => Promise<{ service: CodebaseService; store: ProjectStore & { migrate(): Promise<void> } }>,
) {
  const memory = cli.command("memory").description("Evidence-backed project memory workflow");
  const command = (name: string, description: string) =>
    memory
      .command(name)
      .description(description)
      .option("--project <absolute-path>", "Selected project; defaults to current directory");
  const run = async (
    project: string | undefined,
    action: (app: Awaited<ReturnType<typeof open>>) => Promise<unknown>,
  ) => {
    const app = await open(project);
    try {
      process.stdout.write(`${JSON.stringify(await action(app), null, 2)}\n`);
    } finally {
      await app.store.close();
    }
  };
  command(
    "configure",
    "Enable or disable sending selected excerpts to locally authenticated model CLIs",
  )
    .option("--enable", "Enable Spark extraction and Haiku verification")
    .option("--disable", "Stop further submissions and processing")
    .option("--yes", "Authorize processing selected excerpts with model providers")
    .action(async (o) => {
      if (!!o.enable === !!o.disable)
        throw new CodeMemoryError(
          "INVALID_ARGUMENT",
          "Select exactly one of --enable or --disable",
        );
      if (o.enable && !o.yes)
        throw new CodeMemoryError(
          "CONFIRMATION_REQUIRED",
          "--enable --yes authorizes sending selected project excerpts to Spark and Haiku; active memories still require review",
        );
      await run(o.project, async (app) => {
        await app.store.migrate();
        return app.service.memoryWorkflow.configure(!!o.enable);
      });
    });
  command("status", "Inspect selected project workflow configuration").action((o) =>
    run(o.project, (app) => app.service.memoryWorkflow.status()),
  );
  command(
    "submit <file>",
    "Queue an explicit JSON batch; never reads chat history automatically",
  ).action((file: string, o) =>
    run(o.project, async (app) => {
      const path = resolve(file);
      if ((await stat(path)).size > 16000)
        throw new CodeMemoryError("MEMORY_INPUT_LIMIT", "Input file exceeds 16000 bytes");
      return app.service.memoryWorkflow.submit(JSON.parse(await readFile(path, "utf8")));
    }),
  );
  command("candidates", "Inspect queued jobs or the full evidence for one job")
    .option("--job <id>", "Job ID")
    .option("--limit <number>", "Page size", "5")
    .option("--offset <number>", "Page offset", "0")
    .action((o) =>
      run(o.project, (app) =>
        app.service.memoryWorkflow.list({
          jobId: o.job,
          limit: Number(o.limit),
          offset: Number(o.offset),
        }),
      ),
    );
  command(
    "review <job> <candidate>",
    "Review a concrete candidate after inspecting its claim and evidence",
  )
    .option("--approve", "Approve this verified candidate")
    .option("--reject", "Reject this candidate")
    .option("--yes", "Confirm the selected action")
    .requiredOption("--reason <text>", "Record the user authorization or rejection reason")
    .option("--supersedes <id>", "Explicitly replace an active same-project memory")
    .action((job: string, candidate: string, o) => {
      if (!!o.approve === !!o.reject || !o.yes)
        throw new CodeMemoryError(
          "CONFIRMATION_REQUIRED",
          "Select --approve or --reject and confirm with --yes",
        );
      return run(o.project, (app) =>
        app.service.memoryWorkflow.review({
          jobId: job,
          candidateId: candidate,
          action: o.approve ? "APPROVE" : "REJECT",
          userApproval: o.reason,
          supersedes: o.supersedes,
        }),
      );
    });
  command("retry <job>", "Explicitly retry a failed job; at most three total attempts").action(
    (job: string, o) => run(o.project, (app) => app.service.memoryWorkflow.retry(job)),
  );
  command("recall [task]", "Retrieve relevant project memory before a task")
    .option(
      "--path <path>",
      "Relevant project path; repeat for multiple paths",
      (v: string, prev: string[]) => [...prev, v],
      [],
    )
    .action((task: string | undefined, o) =>
      run(o.project, (app) =>
        app.service.memoryWorkflow.recall({ task: task ?? "", paths: o.path }),
      ),
    );
  command("worker", "Process this project queue; MCP connections also run the worker")
    .option("--once", "Attempt one job and exit")
    .action((o) =>
      run(o.project, async (app) => {
        const controller = new AbortController();
        const stop = () => controller.abort();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        let processed = 0;
        try {
          do {
            if (await app.service.memoryWorkflow.workOnce(controller.signal)) processed++;
            if (o.once || controller.signal.aborted) break;
            await new Promise<void>((r) => {
              const done = () => {
                clearTimeout(timer);
                controller.signal.removeEventListener("abort", done);
                r();
              };
              const timer = setTimeout(done, 3000);
              controller.signal.addEventListener("abort", done, { once: true });
            });
          } while (!controller.signal.aborted);
        } finally {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
        }
        return { processed, stopped: controller.signal.aborted };
      }),
    );
}

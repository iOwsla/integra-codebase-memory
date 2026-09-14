import { resolve } from "node:path";
import type { CodebaseService } from "@codememory/application";
import { CodeMemoryError, type ProjectStore } from "@codememory/core";
import type { Command } from "commander";
export function registerHistoryCommands(
  cli: Command,
  open: (
    project?: string,
  ) => Promise<{ service: CodebaseService; store: ProjectStore & { migrate(): Promise<void> } }>,
) {
  const history = cli
    .command("history")
    .description("Project-scoped documents, Git file changes and reviewed engineering memory");
  const command = (name: string, description: string) =>
    history
      .command(name)
      .description(description)
      .option("--project <path>", "Selected project; defaults to current directory");
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
  command("configure", "Preview source permissions and budgets; --yes applies changes")
    .option("--documents", "Collect Markdown documents")
    .option("--no-documents", "Disable Markdown collection")
    .option("--git", "Collect local history reachable from HEAD")
    .option("--no-git", "Disable Git history collection")
    .option("--wip", "Collect staged, unstaged and eligible untracked files")
    .option("--no-wip", "Disable WIP collection")
    .option("--providers", "Allow selected source evidence to the configured provider")
    .option("--no-providers", "Disable further model processing")
    .option("--automatic", "Collect while an MCP connection is open")
    .option("--no-automatic", "Disable automatic collection")
    .option("--max-file-bytes <number>", "Source read cap; at most 2097152")
    .option("--max-storage-bytes <number>", "Project source excerpt budget")
    .option("--retention-days <number>", "WIP evidence retention")
    .option("--yes", "Apply the selected settings; --providers authorizes model transmission")
    .action((o) =>
      run(o.project, async (app) => {
        if (o.yes) await app.store.migrate();
        return app.service.history.configure({
          documents: o.documents,
          git: o.git,
          wip: o.wip,
          providers: o.providers,
          automatic: o.automatic,
          maxFileBytes: o.maxFileBytes ? Number(o.maxFileBytes) : undefined,
          maxStorageBytes: o.maxStorageBytes ? Number(o.maxStorageBytes) : undefined,
          retentionDays: o.retentionDays ? Number(o.retentionDays) : undefined,
          apply: !!o.yes,
        });
      }),
    );
  command("status", "Inspect collection settings, coverage and progress").action((o) =>
    run(o.project, (app) => app.service.history.status()),
  );
  command("scan", "Collect one bounded batch, or finish all local batches with --all")
    .option("--job <id>", "Resume a collection job")
    .option("--batch-size <number>", "Files per batch, at most 100", "20")
    .option("--all", "Continue bounded batches until completion or failure")
    .action((o) =>
      run(o.project, async (app) => {
        const abort = new AbortController();
        const stop = () => abort.abort();
        process.once("SIGINT", stop);
        process.once("SIGTERM", stop);
        let jobId = o.job;
        let result: Record<string, unknown> = {};
        try {
          do {
            result = await app.service.history.collect(
              { jobId, batchSize: Number(o.batchSize) },
              abort.signal,
            );
            jobId = result.jobId;
            process.stderr.write(
              `HISTORY ${result.stage ?? result.state} | documents ${result.docOffset ?? 0} | commits ${result.commitOffset ?? 0} | files ${result.fileOffset ?? 0} | gaps ${result.gapCount ?? 0}\n`,
            );
            if (!o.all || result.state !== "QUEUED") break;
            await new Promise<void>((r) => setTimeout(r, 10));
          } while (!abort.signal.aborted);
          return result;
        } finally {
          process.removeListener("SIGINT", stop);
          process.removeListener("SIGTERM", stop);
        }
      }),
    );
  command("list [kind]", "List documents, changes, segments or jobs")
    .option("--query <text>", "Search text", "")
    .option("--path <relative-path>", "Exact file path", "")
    .option("--revision <id>", "Document revision for segment listing")
    .option("--limit <number>", "Page size, at most 20", "10")
    .option("--offset <number>", "Page offset", "0")
    .action((kind: string | undefined, o) =>
      run(o.project, (app) =>
        app.service.history.search({
          kind: kind ?? "changes",
          query: o.query,
          path: o.path,
          revisionId: o.revision,
          limit: Number(o.limit),
          offset: Number(o.offset),
        }),
      ),
    );
  command("job <id>", "Inspect a job and page its exact candidate claims and evidence")
    .option("--limit <number>", "Candidates per page, at most 5", "1")
    .option("--offset <number>", "Page offset", "0")
    .action((id: string, o) =>
      run(o.project, (app) =>
        app.service.history.jobDetails({
          jobId: id,
          limit: Number(o.limit),
          offset: Number(o.offset),
        }),
      ),
    );
  command("evidence <ids...>", "Inspect exact segments and current source freshness").action(
    (ids: string[], o) => run(o.project, (app) => app.service.history.evidence({ ids })),
  );
  command("context [task]", "Recall approved rules and related engineering evidence")
    .option(
      "--path <path>",
      "Relevant path; repeat to add more",
      (v: string, p: string[]) => [...p, v],
      [],
    )
    .action((task: string | undefined, o) =>
      run(o.project, (app) =>
        app.service.execute("engineering_context", { task: task ?? "", paths: o.path }),
      ),
    );
  command(
    "submit <batch> <ids...>",
    "Queue exact source segments; requires separate provider opt-in",
  ).action((batch: string, ids: string[], o) =>
    run(o.project, (app) => app.service.history.submit({ batchId: batch, evidenceIds: ids })),
  );
  command("worker", "Process one pending collection or model job").action((o) =>
    run(o.project, async (app) => ({ processed: await app.service.history.workOnce() })),
  );
  command(
    "retry <job>",
    "Retry a failed job explicitly; model attempts are capped at three",
  ).action((job: string, o) => run(o.project, (app) => app.service.history.retry(job)));
  command("cancel <job>", "Cancel a selected project job after its active batch yields").action(
    (job: string, o) => run(o.project, (app) => app.service.history.cancel(job)),
  );
  command("review <job> <candidate>", "Review the exact claim and evidence before approving")
    .option("--approve", "Approve the selected verified documented rule")
    .option("--reject", "Reject the selected candidate")
    .option("--yes", "Confirm this review")
    .requiredOption("--reason <text>", "Actual user authorization")
    .option("--supersedes <id>", "Explicitly replace an active same-project memory")
    .action((job: string, candidate: string, o) => {
      if (!o.yes || !!o.approve === !!o.reject)
        throw new CodeMemoryError(
          "CONFIRMATION_REQUIRED",
          "Select --approve or --reject, provide --reason and --yes",
        );
      return run(o.project, (app) =>
        app.service.history.review({
          jobId: job,
          candidateId: candidate,
          action: o.approve ? "APPROVE" : "REJECT",
          userApproval: o.reason,
          supersedes: o.supersedes,
        }),
      );
    });
  command(
    "backup <file>",
    "Write a private, project-scoped history backup; existing files are never overwritten",
  ).action((file: string, o) => run(o.project, (app) => app.service.history.backup(resolve(file))));
  command(
    "restore <file>",
    "Restore into an empty selected project history and memory scope; leaves collection/providers disabled",
  )
    .option("--yes", "Authorize restoring this backup")
    .action((file: string, o) => {
      if (!o.yes)
        throw new CodeMemoryError(
          "CONFIRMATION_REQUIRED",
          "Restore requires --yes and an empty matching project scope",
        );
      return run(o.project, async (app) => {
        await app.store.migrate();
        return app.service.history.restore(resolve(file));
      });
    });
  command("cleanup", "Preview expired WIP excerpt cleanup; active memories remain")
    .option("--purge", "Remove all captured source excerpts and source-derived job payloads")
    .option("--yes", "Apply the displayed cleanup policy")
    .action((o) => run(o.project, (app) => app.service.history.cleanup(!!o.purge, !!o.yes)));
}

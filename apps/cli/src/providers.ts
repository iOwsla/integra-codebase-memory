import { CodeMemoryError } from "@codememory/core";
import {
  apiProfileSchema,
  credential,
  HttpMemoryProvider,
  ProviderSettings,
  profileName,
} from "@codememory/memory";
import { createProjectContext } from "@codememory/shared";
import type { Command } from "commander";

async function hiddenKey(): Promise<string> {
  if (!process.stdin.isTTY || !process.stdin.setRawMode)
    throw new CodeMemoryError(
      "PROVIDER_TTY_REQUIRED",
      "Use an interactive terminal for secure key entry, or configure an environment credential",
    );
  process.stderr.write("API key (hidden; Ctrl-C cancels): ");
  const previous = process.stdin.isRaw;
  process.stdin.setRawMode(true);
  process.stdin.resume();
  return new Promise((resolve, reject) => {
    let value = "";
    const done = (cancel: boolean) => {
      process.stdin.removeListener("data", data);
      process.stdin.setRawMode(previous);
      process.stdin.pause();
      process.stderr.write("\n");
      if (cancel) reject(new CodeMemoryError("MEMORY_CANCELLED", "Credential entry cancelled"));
      else resolve(value);
    };
    const data = (chunk: Buffer) => {
      for (const c of chunk.toString("utf8")) {
        if (c === "\u0003" || c === "\u0004") {
          done(true);
          return;
        }
        if (c === "\r" || c === "\n") {
          done(false);
          return;
        }
        if (c === "\u007f" || c === "\b") value = value.slice(0, -1);
        else if (c >= " " && value.length < 2048) value += c;
      }
    };
    process.stdin.on("data", data);
  });
}
export function registerProviderCommands(cli: Command) {
  const commands = cli
    .command("providers")
    .description(
      "Shared API profiles and explicit per-project model routing; no database required",
    );
  const settings = new ProviderSettings();
  const print = (v: unknown) => process.stdout.write(`${JSON.stringify(v, null, 2)}\n`);
  commands
    .command("add <name>")
    .description("Create an immutable non-secret provider profile; --yes writes it")
    .option("--provider <type>", "deepseek or openai-compatible", "deepseek")
    .option("--base-url <url>", "HTTPS API base; required for compatible providers")
    .option("--model <id>", "Model identifier; DeepSeek defaults to deepseek-flash")
    .option("--env <name>", "Use only this environment variable instead of OS credential storage")
    .option(
      "--daily-usd <number>",
      "Estimated local daily allowance, not provider billing cap",
      "1",
    )
    .option("--daily-requests <number>", "Maximum daily API attempts", "100")
    .option("--max-output-tokens <number>", "Per-call output cap", "2048")
    .option(
      "--input-rate <number>",
      "USD per million input tokens; required for compatible providers",
    )
    .option(
      "--output-rate <number>",
      "USD per million output tokens; required for compatible providers",
    )
    .option("--yes", "Create this profile; does not enable any project or transmit source")
    .action(async (name: string, o) => {
      if (o.provider !== "deepseek" && (!o.baseUrl || !o.model || !o.inputRate || !o.outputRate))
        throw new CodeMemoryError(
          "PROVIDER_CONFIG_REQUIRED",
          "Compatible profiles require endpoint, model and current input/output rates",
        );
      const profile = apiProfileSchema.parse({
        name,
        provider: o.provider,
        baseUrl: o.baseUrl ?? "https://api.deepseek.com",
        model: o.model ?? "deepseek-flash",
        credential: o.env ? "environment" : "keychain",
        envName: o.env,
        dailyUsd: Number(o.dailyUsd),
        dailyRequests: Number(o.dailyRequests),
        maxOutputTokens: Number(o.maxOutputTokens),
        inputUsdPerMillion: Number(o.inputRate ?? 0.3),
        outputUsdPerMillion: Number(o.outputRate ?? 1.2),
      });
      print({ applied: !!o.yes, profile: o.yes ? await settings.add(profile) : profile });
    });
  commands
    .command("login <name>")
    .description("Read a hidden key and save only in OS credential storage")
    .action(async (name: string) => {
      const p = (await settings.read()).profiles[profileName.parse(name)];
      if (!p) throw new CodeMemoryError("PROVIDER_NOT_FOUND", "Create the profile first");
      if (p.credential !== "keychain")
        throw new CodeMemoryError(
          "PROVIDER_CREDENTIAL_MODE",
          "This profile uses its named environment variable",
        );
      await credential(p, await hiddenKey());
      print({ stored: true, profile: name, storage: "OS_CREDENTIAL_STORE" });
    });
  commands
    .command("logout <name>")
    .description("Delete the profile's OS credential")
    .action(async (name: string) => {
      const p = (await settings.read()).profiles[profileName.parse(name)];
      if (!p) throw new CodeMemoryError("PROVIDER_NOT_FOUND", "Profile not found");
      await credential(p, undefined, true);
      print({ removed: true, profile: name });
    });
  commands
    .command("use <name>")
    .description("Select a profile or cli for this project; requires explicit --yes")
    .option("--project <path>", "Project root; defaults to current directory")
    .option("--workflow <kind>", "history, memory or both", "history")
    .option("--yes", "Authorize routing enabled workflows to this provider")
    .action(async (name: string, o) => {
      if (!["history", "memory", "both"].includes(o.workflow))
        throw new CodeMemoryError("PROVIDER_CONFIG_INVALID", "Unknown workflow");
      const context = await createProjectContext(o.project ?? process.cwd());
      if (o.yes) await settings.bind(context.projectScopeId, o.workflow, name);
      print({
        applied: !!o.yes,
        profile: name,
        workflow: o.workflow,
        projectRoot: context.canonicalRoot,
        next: "Workflow opt-in remains separate. Existing queued jobs use the selection when processing begins; active jobs retain their provider.",
      });
    });
  commands
    .command("status")
    .description("Show non-secret profiles, this project's routing and shared daily usage")
    .option("--project <path>", "Project root; defaults to current directory")
    .action(async (o) => {
      const c = await createProjectContext(o.project ?? process.cwd());
      const s = await settings.read();
      print({
        profiles: Object.values(s.profiles),
        project: c.projectScopeId,
        history: s.bindings[`${c.projectScopeId}:history`] ?? "cli",
        memory: s.bindings[`${c.projectScopeId}:memory`] ?? "cli",
        usage: s.usage,
        allowance:
          "Shared per profile across projects on this machine, UTC day, estimated rates; uncertain attempts retain reservation",
      });
    });
  commands
    .command("test <name>")
    .description("One paid synthetic extraction; sends no project source")
    .option("--yes", "Authorize this bounded API test")
    .action(async (name: string, o) => {
      if (!o.yes)
        throw new CodeMemoryError(
          "CONFIRMATION_REQUIRED",
          "Provider test makes one paid synthetic request; repeat with --yes",
        );
      const p = (await settings.read()).profiles[profileName.parse(name)];
      if (!p) throw new CodeMemoryError("PROVIDER_NOT_FOUND", "Profile not found");
      const result = await new HttpMemoryProvider(p, settings).extract({
        evidence: [],
        instruction: "No evidence exists. Return an empty candidates array.",
      });
      if (!("candidates" in result.output) || result.output.candidates.length !== 0)
        throw new CodeMemoryError(
          "PROVIDER_SMOKE_FAILED",
          "Provider generated candidates without evidence",
        );
      print({ passed: true, metrics: result.metrics });
    });
}

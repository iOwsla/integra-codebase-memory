import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fixture } from "@codememory/test-utils";
import { expect, it } from "vitest";
import {
  CliMemoryProvider,
  providerExitError,
  resolveModelCommand,
  runModelProcess,
} from "../../packages/memory/src/provider";

it("rejects unexpected verifier models instead of silently using Opus", async () => {
  const provider = new CliMemoryProvider(async () =>
    JSON.stringify({
      structured_output: { reviews: [] },
      modelUsage: { "claude-haiku-4-5-20251001": {}, "claude-opus-4-8": {} },
    }),
  );
  await expect(provider.verify({})).rejects.toMatchObject({ code: "MEMORY_MODEL_MISMATCH" });
});
it("pins model and isolation flags, accepts unknown Codex model telemetry explicitly", async () => {
  const calls: { command: string; args: string[] }[] = [];
  const provider = new CliMemoryProvider(async (command, args, _input, cwd) => {
    calls.push({ command, args });
    if (command === "codex") {
      expect(JSON.parse(await readFile(join(cwd, "schema.json"), "utf8")).$schema).toBe(
        "https://json-schema.org/draft/2020-12/schema",
      );
      await writeFile(join(cwd, "output.json"), '{"candidates":[]}');
      return '{"type":"turn.completed","usage":{"input_tokens":1}}';
    }
    expect(JSON.parse(args[args.indexOf("--json-schema") + 1] ?? "null").$schema).toBe(
      "http://json-schema.org/draft-07/schema#",
    );
    return JSON.stringify({
      structured_output: { reviews: [] },
      modelUsage: { "claude-haiku-4-5-20251001": {} },
    });
  });
  expect((await provider.extract({})).metrics).toMatchObject({
    reportedModel: null,
    modelVerified: false,
  });
  await provider.verify({});
  expect(calls[0]?.args).toContain("--ignore-user-config");
  expect(calls[1]?.args).toContain("dontAsk");
  expect(calls[1]?.args).not.toContain("--fallback-model");
});
it("resolves npm Windows CLIs without command-shell quoting", async () => {
  const f = await fixture({ "bin/node_modules/@openai/codex/bin/codex.js": "// fixture" });
  try {
    const result = await resolveModelCommand("codex", "win32", join(f.root, "bin"));
    expect(result.command).toBe(process.execPath);
    expect(result.prefix[0]).toContain("codex.js");
  } finally {
    await f.dispose();
  }
});
it("stops owned processes on cancellation and does not execute input as shell code", async () => {
  const f = await fixture({});
  try {
    const controller = new AbortController();
    const pending = runModelProcess(
      process.execPath,
      ["-e", "setInterval(()=>{},1000)"],
      "$(never-execute)",
      f.root,
      controller.signal,
    );
    setTimeout(() => controller.abort(), 100);
    await expect(pending).rejects.toMatchObject({ code: "MEMORY_CANCELLED" });
  } finally {
    await f.dispose();
  }
});

it("does not pass database credentials or runtime injection settings to model processes", async () => {
  const { modelEnvironment } = await import("../../packages/memory/src/provider");
  expect(
    modelEnvironment({
      PATH: "/safe/bin",
      HOME: "/safe/home",
      DATABASE_URL: "private",
      TEST_DATABASE_URL: "private",
      NODE_OPTIONS: "--require untrusted",
      ANTHROPIC_API_KEY: "not-subscription",
    }),
  ).toEqual({ PATH: "/safe/bin", HOME: "/safe/home" });
});

it("validates JSON-text verifier responses with the same schema and rejects renamed fields", async () => {
  const modelUsage = { "claude-haiku-4-5-20251001": {} };
  const good = new CliMemoryProvider(async () =>
    JSON.stringify({ modelUsage, result: '{"reviews":[]}' }),
  );
  expect((await good.verify({})).metrics.outputFormat).toBe("validated_json_text");
  const bad = new CliMemoryProvider(async () =>
    JSON.stringify({
      modelUsage,
      result: JSON.stringify({
        reviews: [
          {
            candidateId: "c1",
            decision: "SUPPORTED",
            reasonCode: "MADE_UP",
            reason: "unsupported field names",
            eligibleForReview: true,
          },
        ],
      }),
    }),
  );
  await expect(bad.verify({})).rejects.toMatchObject({ code: "MEMORY_VERIFICATION_SCHEMA" });
});

it("reports schema incompatibility without leaking arbitrary stderr", async () => {
  const error = providerExitError(
    1,
    'Error: --json-schema is not a valid JSON Schema: no schema with key or ref "https://json-schema.org/draft/2020-12/schema" private-token private-conversation',
  );
  expect(error.code).toBe("MEMORY_PROVIDER_SCHEMA_UNSUPPORTED");
  expect(error.message).not.toContain("private-");
  expect(providerExitError(7, "unknown private data").message).toContain("exit 7");
  const f = await fixture({});
  try {
    await expect(
      runModelProcess(
        process.execPath,
        [
          "-e",
          'process.stderr.write("Error: --json-schema is not a valid JSON Schema: secret-value"); process.exit(1)',
        ],
        "",
        f.root,
      ),
    ).rejects.toMatchObject({ code: "MEMORY_PROVIDER_SCHEMA_UNSUPPORTED" });
  } finally {
    await f.dispose();
  }
});

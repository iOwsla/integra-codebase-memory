import { CodeMemoryError } from "@codememory/core";
import { z } from "zod";
import {
  extractionPrompt,
  extractionSchema,
  verificationPrompt,
  verificationSchema,
} from "./protocol";
import { CliMemoryProvider, type MemoryModelProvider } from "./provider";
import { type ApiProfile, credential, ProviderSettings } from "./provider-settings";

const replySchema = z.object({
  model: z.string().max(200).optional(),
  choices: z
    .array(
      z.object({
        finish_reason: z.string(),
        message: z.object({ content: z.string().max(65536).nullable() }),
      }),
    )
    .length(1),
  usage: z
    .object({
      prompt_tokens: z.number().int().nonnegative(),
      completion_tokens: z.number().int().nonnegative(),
    })
    .optional(),
});
const defaultPrompts = { extraction: extractionPrompt, verification: verificationPrompt };
export class HttpMemoryProvider implements MemoryModelProvider {
  constructor(
    readonly profile: ApiProfile,
    private readonly settings = new ProviderSettings(),
    private readonly prompts = defaultPrompts,
    private readonly fetcher: typeof fetch = fetch,
    private readonly getKey: (p: ApiProfile) => Promise<string | null> = credential,
  ) {}
  extract(input: unknown, signal?: AbortSignal) {
    return this.call("extraction", input, signal);
  }
  verify(input: unknown, signal?: AbortSignal) {
    return this.call("verification", input, signal);
  }
  private async call(kind: "extraction" | "verification", input: unknown, signal?: AbortSignal) {
    const p = this.profile;
    const schema = kind === "extraction" ? extractionSchema : verificationSchema;
    const system = `${this.prompts[kind]}\nReturn only JSON matching this schema:\n${JSON.stringify(z.toJSONSchema(schema, { target: "draft-7" }))}`;
    const user = JSON.stringify(input);
    const bytes = Buffer.byteLength(system) + Buffer.byteLength(user);
    if (bytes > p.maxInputBytes)
      throw new CodeMemoryError("MEMORY_INPUT_LIMIT", "Provider input exceeds configured byte cap");
    const combined = AbortSignal.any([...(signal ? [signal] : []), AbortSignal.timeout(120000)]);
    if (combined.aborted) throw new CodeMemoryError("MEMORY_CANCELLED", "Worker stopped");
    const key = await this.getKey(p);
    if (!key || /[\r\n]/.test(key))
      throw new CodeMemoryError(
        "PROVIDER_KEY_MISSING",
        "Configure this provider credential locally; never paste it into chat",
      );
    const reservation = await this.settings.reserve(p, bytes);
    const started = Date.now();
    try {
      const response = await this.fetcher(`${p.baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        redirect: "error",
        signal: combined,
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model: p.model,
          stream: false,
          max_tokens: p.maxOutputTokens,
          messages: [
            { role: "system", content: system },
            { role: "user", content: user },
          ],
          response_format: { type: "json_object" },
          ...(p.provider === "deepseek" ? { thinking: { type: "disabled" } } : {}),
        }),
      });
      if (!response.ok) {
        await response.body?.cancel();
        const code =
          response.status === 401 || response.status === 403
            ? "PROVIDER_AUTH"
            : response.status === 429
              ? "PROVIDER_RATE_LIMIT"
              : response.status === 402
                ? "PROVIDER_BALANCE"
                : "PROVIDER_HTTP_ERROR";
        throw new CodeMemoryError(
          code,
          `Provider HTTP ${response.status}; response body omitted; no automatic retry or fallback`,
        );
      }
      const reader = response.body?.getReader();
      if (!reader) throw new CodeMemoryError("MEMORY_PROVIDER_PROTOCOL", "Empty provider response");
      const chunks: Uint8Array[] = [];
      let length = 0;
      try {
        while (true) {
          const item = await reader.read();
          if (item.done) break;
          length += item.value.byteLength;
          if (length > 2 * 1024 * 1024)
            throw new CodeMemoryError("MEMORY_OUTPUT_LIMIT", "Provider response exceeds 2 MiB");
          chunks.push(item.value);
        }
      } finally {
        await reader.cancel().catch(() => {});
      }
      const result = replySchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
      if (!result.success)
        throw new CodeMemoryError("MEMORY_PROVIDER_PROTOCOL", "Unexpected provider response shape");
      const reply = result.data;
      if (reply.usage)
        await this.settings.settle(
          p,
          reservation,
          reply.usage.prompt_tokens,
          reply.usage.completion_tokens,
        );
      const choice = reply.choices[0];
      if (choice?.finish_reason !== "stop" || !choice.message.content)
        throw new CodeMemoryError(
          "MEMORY_PROVIDER_INCOMPLETE",
          "Model output was truncated, refused or empty",
        );
      const output = schema.safeParse(JSON.parse(choice.message.content));
      if (!output.success)
        throw new CodeMemoryError(
          "MEMORY_PROVIDER_PROTOCOL",
          "Model JSON does not match the evidence protocol",
        );
      return {
        output: output.data,
        metrics: {
          provider: p.provider,
          profile: p.name,
          requestedModel: p.model,
          reportedModel: reply.model ?? null,
          modelVerified: false,
          modelIdentity: "PROVIDER_REPORTED_NOT_INDEPENDENTLY_VERIFIED",
          elapsedMs: Date.now() - started,
          usage: reply.usage ?? null,
          estimatedUsd: reply.usage
            ? (reply.usage.prompt_tokens * p.inputUsdPerMillion +
                reply.usage.completion_tokens * p.outputUsdPerMillion) /
              1e6
            : null,
          reservationRetained: !reply.usage,
        },
      };
    } catch (e) {
      if (e instanceof CodeMemoryError) throw e;
      throw new CodeMemoryError(
        signal?.aborted
          ? "MEMORY_CANCELLED"
          : combined.aborted
            ? "MEMORY_PROVIDER_TIMEOUT"
            : "MEMORY_PROVIDER_PROTOCOL",
        "Provider request failed; raw network/model output omitted; no automatic retry or fallback",
      );
    }
  }
}
/** Resolve explicit project bindings at job start, keeping extraction and verification on one profile. */
export class ConfiguredMemoryProvider implements MemoryModelProvider {
  private active: MemoryModelProvider | undefined;
  constructor(
    private readonly scope: string,
    private readonly workflow: "history" | "memory",
    private readonly prompts = defaultPrompts,
    private readonly settings = new ProviderSettings(),
  ) {}
  async describe() {
    const p = await this.settings.selected(this.scope, this.workflow);
    return p
      ? {
          transport: "HTTP",
          profile: p.name,
          provider: p.provider,
          model: p.model,
          verification: "SEPARATE_CALL_SAME_MODEL",
          dailyUsd: p.dailyUsd,
          dailyRequests: p.dailyRequests,
        }
      : { transport: "CLI", extraction: "spark", verification: "haiku" };
  }
  async extract(input: unknown, signal?: AbortSignal) {
    const p = await this.settings.selected(this.scope, this.workflow);
    this.active = p
      ? new HttpMemoryProvider(p, this.settings, this.prompts)
      : new CliMemoryProvider(undefined, this.prompts);
    return this.active.extract(input, signal);
  }
  async verify(input: unknown, signal?: AbortSignal) {
    if (!this.active)
      throw new CodeMemoryError(
        "PROVIDER_JOB_NOT_STARTED",
        "Extraction must select the provider before verification",
      );
    return this.active.verify(input, signal);
  }
}

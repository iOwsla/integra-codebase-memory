import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { CodeMemoryError } from "@codememory/core";
import { z } from "zod";

export const profileName = z.string().regex(/^[a-z][a-z0-9-]{0,39}$/);
export const apiProfileSchema = z
  .object({
    name: profileName,
    provider: z.enum(["deepseek", "openai-compatible"]),
    baseUrl: z.string().url(),
    model: z.string().regex(/^[a-zA-Z0-9][a-zA-Z0-9._:/-]{0,99}$/),
    credential: z.enum(["keychain", "environment"]).default("keychain"),
    envName: z
      .string()
      .regex(/^[A-Z][A-Z0-9_]{0,99}$/)
      .optional(),
    maxOutputTokens: z.number().int().min(256).max(8192).default(2048),
    maxInputBytes: z.number().int().min(1024).max(262144).default(65536),
    dailyUsd: z.number().positive().max(100).default(1),
    dailyRequests: z.number().int().min(1).max(10000).default(100),
    inputUsdPerMillion: z.number().positive().max(1000).default(0.3),
    outputUsdPerMillion: z.number().positive().max(1000).default(1.2),
  })
  .strict()
  .superRefine((p, ctx) => {
    const url = new URL(p.baseUrl);
    if (url.protocol !== "https:" || url.username || url.password || url.search || url.hash)
      ctx.addIssue({
        code: "custom",
        message: "Endpoint must be HTTPS without credentials, query or fragment",
      });
    if (p.provider === "deepseek" && url.href.replace(/\/$/, "") !== "https://api.deepseek.com")
      ctx.addIssue({ code: "custom", message: "DeepSeek uses its official endpoint" });
    if (p.credential === "environment" && !p.envName)
      ctx.addIssue({ code: "custom", message: "Environment credential requires envName" });
  });
export type ApiProfile = z.infer<typeof apiProfileSchema>;
const usageSchema = z.object({
  requests: z.number().int().nonnegative(),
  chargedUsd: z.number().nonnegative(),
  inputTokens: z.number().nonnegative(),
  outputTokens: z.number().nonnegative(),
  uncertainRequests: z.number().int().nonnegative(),
});
const stateSchema = z.object({
  profiles: z.record(z.string(), apiProfileSchema),
  bindings: z.record(z.string(), z.string()),
  usage: z.record(z.string(), usageSchema),
});
export const providerDirectory = () =>
  process.env.CODEMEMORY_PROVIDER_DIR ||
  join(
    process.platform === "win32" ? process.env.LOCALAPPDATA || homedir() : homedir(),
    process.platform === "win32" ? "integra-code-memory" : ".integra-code-memory",
    "providers",
  );
/** Non-secret user state, outside repositories and independent of release directories. */
export class ProviderSettings {
  constructor(readonly directory = providerDirectory()) {}
  async read() {
    try {
      return stateSchema.parse(
        JSON.parse(await readFile(join(this.directory, "state.json"), "utf8")),
      );
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT")
        return { profiles: {}, bindings: {}, usage: {} } as z.infer<typeof stateSchema>;
      throw new CodeMemoryError(
        "PROVIDER_CONFIG_INVALID",
        "Provider state is unreadable; no provider fallback performed",
      );
    }
  }
  private async change<T>(fn: (s: z.infer<typeof stateSchema>) => T) {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    const lock = join(this.directory, "state.lock");
    try {
      await mkdir(lock);
    } catch {
      throw new CodeMemoryError(
        "PROVIDER_STATE_BUSY",
        "Provider state is locked; retry after the other operation exits. A crash lock requires manual inspection.",
      );
    }
    const temp = join(this.directory, `${randomUUID()}.tmp`);
    try {
      const state = await this.read();
      const result = fn(state);
      await writeFile(temp, JSON.stringify(state), { mode: 0o600, flag: "wx" });
      await rename(temp, join(this.directory, "state.json"));
      return result;
    } finally {
      await rm(temp, { force: true });
      await rm(lock, { recursive: true });
    }
  }
  async add(input: unknown) {
    const profile = apiProfileSchema.parse(input);
    await this.change((s) => {
      if (s.profiles[profile.name])
        throw new CodeMemoryError(
          "PROVIDER_EXISTS",
          "Profiles are immutable; create a new profile and explicitly select it",
        );
      s.profiles[profile.name] = profile;
    });
    return profile;
  }
  async bind(scope: string, workflow: "history" | "memory" | "both", name: string) {
    await this.change((s) => {
      if (name !== "cli" && !s.profiles[name])
        throw new CodeMemoryError("PROVIDER_NOT_FOUND", "Provider profile not found");
      for (const w of workflow === "both" ? ["history", "memory"] : [workflow]) {
        const key = `${scope}:${w}`;
        if (name === "cli") delete s.bindings[key];
        else s.bindings[key] = name;
      }
    });
  }
  async selected(scope: string, workflow: string) {
    const s = await this.read();
    const name = s.bindings[`${scope}:${workflow}`];
    if (!name) return null;
    if (!s.profiles[name])
      throw new CodeMemoryError(
        "PROVIDER_NOT_FOUND",
        "Selected profile missing; no CLI fallback performed",
      );
    return s.profiles[name];
  }
  async reserve(p: ApiProfile, inputBytes: number) {
    // Deliberately conservative byte-based estimate; not a provider billing guarantee.
    const cost =
      (inputBytes * p.inputUsdPerMillion + p.maxOutputTokens * p.outputUsdPerMillion) / 1e6;
    const key = `${p.name}:${new Date().toISOString().slice(0, 10)}`;
    await this.change((s) => {
      s.usage[key] ??= {
        requests: 0,
        chargedUsd: 0,
        inputTokens: 0,
        outputTokens: 0,
        uncertainRequests: 0,
      };
      const u = s.usage[key];
      if (u.requests >= p.dailyRequests || u.chargedUsd + cost > p.dailyUsd)
        throw new CodeMemoryError(
          "PROVIDER_BUDGET_EXCEEDED",
          "Local daily provider allowance exhausted; no request sent",
        );
      u.requests++;
      u.chargedUsd += cost;
      u.uncertainRequests++;
    });
    return { key, cost };
  }
  async settle(
    p: ApiProfile,
    reservation: { key: string; cost: number },
    input: number,
    output: number,
  ) {
    await this.change((s) => {
      const u = s.usage[reservation.key];
      if (!u) throw new CodeMemoryError("PROVIDER_USAGE_INVALID", "Usage reservation missing");
      u.chargedUsd = Math.max(
        0,
        u.chargedUsd -
          reservation.cost +
          (input * p.inputUsdPerMillion + output * p.outputUsdPerMillion) / 1e6,
      );
      u.inputTokens += input;
      u.outputTokens += output;
      u.uncertainRequests--;
    });
  }
}
const secretService = "io.integra.codememory.providers";
export async function credential(
  p: ApiProfile,
  value?: string,
  remove = false,
): Promise<string | null> {
  if (p.credential === "environment") {
    if (value !== undefined || remove)
      throw new CodeMemoryError(
        "PROVIDER_CREDENTIAL_MODE",
        "Manage this explicitly selected environment variable outside CodeMemory",
      );
    return process.env[p.envName ?? ""] ?? null;
  }
  try {
    if (typeof Bun === "undefined" || !Bun.secrets) throw new Error();
    const options = { service: secretService, name: p.name };
    if (remove) {
      await Bun.secrets.delete(options);
      return null;
    }
    if (value !== undefined) {
      if (!value.trim() || value.length > 2048 || /[\r\n]/.test(value)) throw new Error();
      await Bun.secrets.set({ ...options, value });
      return null;
    }
    return await Bun.secrets.get(options);
  } catch {
    throw new CodeMemoryError(
      "PROVIDER_CREDENTIAL_UNAVAILABLE",
      "OS credential store unavailable or invalid key; use an explicitly configured environment credential on headless hosts",
    );
  }
}

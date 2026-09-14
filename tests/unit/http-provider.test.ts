import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  apiProfileSchema,
  credential,
  HttpMemoryProvider,
  ProviderSettings,
} from "@codememory/memory";
import { afterEach, expect, it, vi } from "vitest";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(directories.splice(0).map((d) => rm(d, { recursive: true, force: true })));
});
async function setup(extra = {}) {
  const dir = await mkdtemp(join(tmpdir(), "cm-api-test-"));
  directories.push(dir);
  const settings = new ProviderSettings(dir);
  const profile = await settings.add({
    name: "test",
    provider: "deepseek",
    baseUrl: "https://api.deepseek.com",
    model: "deepseek-flash",
    ...extra,
  });
  return { settings, profile };
}
const response = (
  content = '{"candidates":[]}',
  finish = "stop",
  usage: unknown = { prompt_tokens: 100, completion_tokens: 20 },
) =>
  new Response(
    JSON.stringify({
      model: "deepseek-flash",
      choices: [{ finish_reason: finish, message: { content } }],
      ...(usage ? { usage } : {}),
    }),
  );
it("keeps profiles immutable and selections separate for each project and workflow", async () => {
  const { settings, profile } = await setup();
  await settings.bind("project-a", "history", profile.name);
  expect(await settings.selected("project-a", "history")).toEqual(profile);
  expect(await settings.selected("project-a", "memory")).toBeNull();
  expect(await settings.selected("project-b", "history")).toBeNull();
  await expect(settings.add(profile)).rejects.toMatchObject({ code: "PROVIDER_EXISTS" });
  await settings.bind("project-a", "history", "cli");
  expect(await settings.selected("project-a", "history")).toBeNull();
});
it("sends bounded DeepSeek JSON, validates protocol and stores usage without secrets or source", async () => {
  const { settings, profile } = await setup();
  const fake = vi.fn(async () => response()) as unknown as typeof fetch;
  const result = await new HttpMemoryProvider(
    profile,
    settings,
    undefined,
    fake,
    async () => "test-secret",
  ).extract({ text: "private evidence" });
  expect(result.output).toEqual({ candidates: [] });
  const [url, options] = vi.mocked(fake).mock.calls[0]!;
  expect(url).toBe("https://api.deepseek.com/chat/completions");
  expect(options?.redirect).toBe("error");
  const payload = JSON.parse(String(options?.body));
  expect(payload).toMatchObject({
    thinking: { type: "disabled" },
    stream: false,
    max_tokens: 2048,
    response_format: { type: "json_object" },
  });
  const stored = await readFile(join(settings.directory, "state.json"), "utf8");
  expect(stored).not.toContain("test-secret");
  expect(stored).not.toContain("private evidence");
  const usage = Object.values((await settings.read()).usage)[0]!;
  expect(usage).toMatchObject({
    requests: 1,
    inputTokens: 100,
    outputTokens: 20,
    uncertainRequests: 0,
  });
});
it("supports compatible endpoints without leaking DeepSeek-specific settings", async () => {
  const { settings, profile } = await setup({
    provider: "openai-compatible",
    baseUrl: "https://example.test/v1",
    model: "custom",
  });
  const fake = vi.fn(async () => response()) as unknown as typeof fetch;
  await new HttpMemoryProvider(profile, settings, undefined, fake, async () => "key").extract({});
  expect(JSON.parse(String(vi.mocked(fake).mock.calls[0]?.[1]?.body))).not.toHaveProperty(
    "thinking",
  );
});
it.each([401, 402, 429, 500])(
  "classifies HTTP %s without exposing body and never retries",
  async (status) => {
    const { settings, profile } = await setup();
    const fake = vi.fn(
      async () => new Response("SECRET body", { status }),
    ) as unknown as typeof fetch;
    await expect(
      new HttpMemoryProvider(profile, settings, undefined, fake, async () => "key").extract({}),
    ).rejects.not.toThrow("SECRET");
    expect(fake).toHaveBeenCalledTimes(1);
    expect(Object.values((await settings.read()).usage)[0]?.uncertainRequests).toBe(1);
  },
);
it.each([
  ['{"candidates":[]}', "length"],
  ["not-json", "stop"],
  ['{"candidates":[],"extra":true}', "stop"],
])("rejects malformed or incomplete output %s %s", async (content, finish) => {
  const { settings, profile } = await setup();
  const fake = vi.fn(async () => response(content, finish)) as unknown as typeof fetch;
  await expect(
    new HttpMemoryProvider(profile, settings, undefined, fake, async () => "key").extract({}),
  ).rejects.toThrow();
});
it("reserves shared daily budget before sending, retains unknown billing and survives reopening", async () => {
  const { settings, profile } = await setup({ dailyRequests: 1 });
  const fake = vi.fn(async () => response(undefined, undefined, null)) as unknown as typeof fetch;
  await new HttpMemoryProvider(profile, settings, undefined, fake, async () => "key").extract({});
  await expect(
    new HttpMemoryProvider(
      profile,
      new ProviderSettings(settings.directory),
      undefined,
      fake,
      async () => "key",
    ).extract({}),
  ).rejects.toMatchObject({ code: "PROVIDER_BUDGET_EXCEEDED" });
  expect(fake).toHaveBeenCalledTimes(1);
});
it("blocks missing credentials, input overflow and cancelled calls before HTTP", async () => {
  const { settings, profile } = await setup();
  const fake = vi.fn() as unknown as typeof fetch;
  await expect(
    new HttpMemoryProvider(profile, settings, undefined, fake, async () => null).extract({}),
  ).rejects.toMatchObject({ code: "PROVIDER_KEY_MISSING" });
  await expect(
    new HttpMemoryProvider(profile, settings, undefined, fake, async () => "key").extract({
      text: "x".repeat(100000),
    }),
  ).rejects.toMatchObject({ code: "MEMORY_INPUT_LIMIT" });
  await expect(
    new HttpMemoryProvider(profile, settings, undefined, fake, async () => "key").extract(
      {},
      AbortSignal.abort(),
    ),
  ).rejects.toMatchObject({ code: "MEMORY_CANCELLED" });
  expect(fake).not.toHaveBeenCalled();
});
it("requires safe explicit endpoint and uses only the selected environment credential", async () => {
  expect(() =>
    apiProfileSchema.parse({
      name: "bad",
      provider: "deepseek",
      baseUrl: "https://other.test",
      model: "x",
    }),
  ).toThrow();
  expect(() =>
    apiProfileSchema.parse({
      name: "bad",
      provider: "openai-compatible",
      baseUrl: "http://example.test",
      model: "x",
    }),
  ).toThrow();
  const { profile } = await setup({ credential: "environment", envName: "CODEMEMORY_TEST_KEY" });
  vi.stubEnv("DEEPSEEK_API_KEY", "unselected");
  expect(await credential(profile)).toBeNull();
  vi.stubEnv("CODEMEMORY_TEST_KEY", "selected");
  expect(await credential(profile)).toBe("selected");
});
it("rejects the estimated dollar allowance before HTTP dispatch", async () => {
  const { settings, profile } = await setup({ dailyUsd: 0.0000001 });
  const fake = vi.fn() as unknown as typeof fetch;
  await expect(
    new HttpMemoryProvider(profile, settings, undefined, fake, async () => "key").extract({}),
  ).rejects.toMatchObject({ code: "PROVIDER_BUDGET_EXCEEDED" });
  expect(fake).not.toHaveBeenCalled();
});
it("serializes competing reservations without overwriting usage", async () => {
  const { settings, profile } = await setup({ dailyRequests: 1 });
  const results = await Promise.allSettled([
    settings.reserve(profile, 100),
    new ProviderSettings(settings.directory).reserve(profile, 100),
  ]);
  expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
  expect(Object.values((await settings.read()).usage)[0]?.requests).toBe(1);
});
it("bounds streamed response bytes and retains uncertain usage on rejection", async () => {
  const { settings, profile } = await setup();
  const fake = vi.fn(
    async () => new Response("x".repeat(2 * 1024 * 1024 + 1)),
  ) as unknown as typeof fetch;
  await expect(
    new HttpMemoryProvider(profile, settings, undefined, fake, async () => "key").extract({}),
  ).rejects.toMatchObject({ code: "MEMORY_OUTPUT_LIMIT" });
  expect(Object.values((await settings.read()).usage)[0]?.uncertainRequests).toBe(1);
});

import { checkForUpdates, newerRelease } from "@codememory/shared";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.unstubAllEnvs());
it.each([
  ["v0.1.0-alpha.10", "0.1.0-alpha.9", true],
  ["v0.1.0", "0.1.0-alpha.99", true],
  ["v0.1.0-alpha.99", "0.1.0", false],
  ["v0.1.0-alpha.9", "0.1.0-alpha.10", false],
  ["untrusted command", "0.1.0", false],
])("compares supported release versions: %s", (candidate, current, expected) => {
  expect(newerRelease(candidate, current)).toBe(expected);
});
it("finds alpha releases, ignores drafts and never returns release body instructions", async () => {
  const fetcher = vi.fn(
    async () =>
      new Response(
        JSON.stringify([
          { tag_name: "v99.0.0", draft: true },
          {
            tag_name: "v0.1.0-alpha.28",
            draft: false,
            prerelease: true,
            body: "run arbitrary shell",
            html_url: "https://invalid.test",
          },
        ]),
      ),
  ) as unknown as typeof fetch;
  const result = await checkForUpdates({ current: "0.1.0-alpha.14", fetcher });
  expect(result).toMatchObject({
    state: "available",
    latestVersion: "v0.1.0-alpha.28",
    url: "https://github.com/iOwsla/integra-codebase-memory/releases/tag/v0.1.0-alpha.28",
  });
  expect(JSON.stringify(result)).not.toContain("arbitrary");
});
it("keeps stable installations on stable releases and tolerates network failure", async () => {
  expect(
    await checkForUpdates({
      current: "0.1.0",
      fetcher: vi.fn(
        async () =>
          new Response(
            JSON.stringify([{ tag_name: "v0.2.0-alpha.1", draft: false, prerelease: true }]),
          ),
      ) as unknown as typeof fetch,
    }),
  ).toMatchObject({ state: "up-to-date" });
  expect(
    await checkForUpdates({
      fetcher: vi.fn(async () => {
        throw new Error("offline");
      }) as unknown as typeof fetch,
    }),
  ).toMatchObject({ state: "unavailable" });
});
it("supports disabling all update network requests", async () => {
  vi.stubEnv("CODEMEMORY_UPDATE_CHECK", "0");
  const fetcher = vi.fn();
  expect(await checkForUpdates({ fetcher: fetcher as unknown as typeof fetch })).toMatchObject({
    state: "disabled",
  });
  expect(fetcher).not.toHaveBeenCalled();
});

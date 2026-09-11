import { CodeMemoryError, type ProjectContext, type ProjectStore } from "@codememory/core";
import { type IndexService, ProjectSession } from "@codememory/indexer";
import { configSchema } from "@codememory/shared";
import { afterEach, expect, it, vi } from "vitest";

afterEach(() => vi.useRealTimers());
it("exposes safe parser details during failure and clears them after a successful retry", async () => {
  vi.useFakeTimers();
  const context = {
    sessionId: "test",
    indexVersion: "0",
    canonicalRoot: "/selected",
    projectScopeId: "scope",
    effectiveConfig: configSchema.parse({}),
  } as ProjectContext;
  const store = {
    register: vi.fn(),
    status: vi.fn(async () => ({ version: 0 })),
    recordFailure: vi.fn(async () => {}),
  } as unknown as ProjectStore;
  const index = vi
    .fn()
    .mockRejectedValueOnce(
      new CodeMemoryError("PARSER_ERROR", "Parser worker exceeded the 1024 MiB output limit"),
    )
    .mockResolvedValue({ version: 1 });
  const session = new ProjectSession(
    context,
    store,
    { index } as unknown as IndexService,
    true,
    false,
  );
  try {
    await session.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(await session.status()).toMatchObject({
      state: "ERROR",
      error: "PARSER_ERROR",
      errorMessage: "Parser worker exceeded the 1024 MiB output limit",
    });
    await session.start();
    await vi.advanceTimersByTimeAsync(1);
    expect(await session.status()).toMatchObject({ error: undefined, errorMessage: undefined });
  } finally {
    await session.close();
  }
});

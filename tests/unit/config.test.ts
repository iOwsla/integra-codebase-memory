import { createProjectContext, publicError } from "@codememory/shared";
import { fixture } from "@codememory/test-utils";
import { expect, it } from "vitest";

it("reports malformed project config as CONFIGURATION_ERROR without echoing it", async () => {
  const f = await fixture({ ".codememory/config.json": '{"debounceMs": 100, "secretish": 1,}' });
  try {
    const failure = await createProjectContext(f.root).catch((error: unknown) => error);
    expect(failure).toMatchObject({
      code: "CONFIGURATION_ERROR",
      message: ".codememory/config.json is not valid JSON",
    });
    expect(publicError(failure)).toMatchObject({ code: "CONFIGURATION_ERROR" });
  } finally {
    await f.dispose();
  }
});

it("uses defaults when the config is missing and accepts a UTF-8 BOM", async () => {
  const missing = await fixture({ "main.ts": "export const a=1" }),
    bom = await fixture({ ".codememory/config.json": '﻿{"debounceMs": 100}' });
  try {
    expect((await createProjectContext(missing.root)).effectiveConfig).toMatchObject({
      parserTimeoutMs: 120000,
      parserOutputLimitMiB: 4096,
      debounceMs: 300,
    });
    expect((await createProjectContext(bom.root)).effectiveConfig.debounceMs).toBe(100);
  } finally {
    await missing.dispose();
    await bom.dispose();
  }
});

import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture } from "@codememory/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import {
  assertProjectEnabled,
  installManagementCli,
  listRegistrations,
  saveRegistration,
  sharedEntry,
} from "../../scripts/setup/cli-state";

afterEach(() => vi.unstubAllEnvs());
it("installs CLI and persists selected registrations before database provisioning", async () => {
  const f = await fixture({});
  try {
    vi.stubEnv("XDG_DATA_HOME", f.root);
    vi.stubEnv("LOCALAPPDATA", f.root);
    const cli = await installManagementCli();
    expect(await readFile(cli.executable, "utf8")).toContain(sharedEntry());
    expect(await listRegistrations()).toEqual([]);
    const entry = {
      root: resolve(f.root, "selected"),
      client: "both" as const,
      managed: true,
      enabled: true,
    };
    await saveRegistration(entry);
    await saveRegistration(entry);
    expect(await listRegistrations()).toEqual([entry]);
    await assertProjectEnabled(entry.root);
    await saveRegistration({ ...entry, enabled: false });
    await expect(assertProjectEnabled(entry.root)).rejects.toThrow("Project disabled");
    await assertProjectEnabled(resolve(f.root, "unregistered"));
    await saveRegistration(entry);
    await assertProjectEnabled(entry.root);
  } finally {
    await f.dispose();
  }
});

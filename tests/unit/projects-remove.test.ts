import { execFile } from "node:child_process";
import { mkdir, rm, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { promisify } from "node:util";
import { fixture } from "@codememory/test-utils";
import { afterEach, expect, it, vi } from "vitest";
import { runtimeRoot } from "../../scripts/runtime-root";
import { listRegistrations, saveRegistration } from "../../scripts/setup/cli-state";

afterEach(() => vi.unstubAllEnvs());
// The CLI runs under Bun so the workspace subpath imports of management.ts resolve.
const remove = (path: string, service: string) =>
  promisify(execFile)(
    "bun",
    [resolve(runtimeRoot, "apps/cli/src/index.ts"), "projects", "remove", path, "--yes"],
    {
      env: { ...process.env, CODEMEMORY_SERVICE_DIR: service, CODEMEMORY_UPDATE_CHECK: "0" },
      timeout: 20000,
    },
  );
async function registered(root: string, service: string) {
  vi.stubEnv("CODEMEMORY_SERVICE_DIR", service);
  const entry = { root, client: "both" as const, managed: true, enabled: true };
  await saveRegistration(entry);
  return entry;
}

it("disables a registration reached through a symlinked parent directory", async () => {
  const f = await fixture({});
  try {
    const service = resolve(f.root, "state/service");
    const project = resolve(f.root, "real/project");
    await mkdir(project, { recursive: true });
    await symlink(resolve(f.root, "real"), resolve(f.root, "alias"));
    const entry = await registered(project, service);
    await remove(resolve(f.root, "alias/project"), service);
    expect(await listRegistrations()).toEqual([{ ...entry, enabled: false }]);
  } finally {
    await f.dispose();
  }
});

it("disables a registration whose project directory was deleted", async () => {
  const f = await fixture({});
  try {
    const service = resolve(f.root, "state/service");
    const project = resolve(f.root, "gone");
    await mkdir(project);
    const entry = await registered(project, service);
    await rm(project, { recursive: true });
    await remove(project, service);
    expect(await listRegistrations()).toEqual([{ ...entry, enabled: false }]);
    await expect(remove(resolve(f.root, "never-registered"), service)).rejects.toThrow(
      "Project is not registered",
    );
  } finally {
    await f.dispose();
  }
});

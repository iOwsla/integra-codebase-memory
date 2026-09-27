import { mkdir, readdir, readFile, symlink } from "node:fs/promises";
import { resolve } from "node:path";
import { fixture } from "@codememory/test-utils";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  composeDefinition,
  createService,
  databaseUrl,
  readService,
  volumeName,
} from "../../scripts/setup/service-state";
import { ensureDocker, type Run, setupServices } from "../../scripts/setup/services";

beforeEach(() => {
  vi.stubGlobal("Bun", { which: () => "docker", sleep: async () => {} });
  vi.stubEnv("DOCKER_HOST", "");
});
afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});
function engine(
  overrides: (command: string[]) => { code: number; out: string } | undefined = () => undefined,
) {
  return vi.fn<Run>(
    async (command) =>
      overrides(command) || {
        code: 0,
        out: command.includes("info")
          ? command.includes("{{.ID}}")
            ? "test-engine\n"
            : "linux\n"
          : command.includes("context")
            ? command.includes("show")
              ? "default\n"
              : "unix:///var/run/docker.sock\n"
            : "",
      },
  );
}
it("keeps credentials and volume identity across repeated setup, ignores application DATABASE_URL", async () => {
  const f = await fixture({});
  try {
    const directory = resolve(f.root, "service");
    vi.stubEnv("DATABASE_URL", "postgresql://application.invalid/never-use");
    const migrate = vi.fn(async (_url: string) => {});
    const execute = engine();
    await setupServices({ directory, execute, migrate });
    const first = await readService(directory);
    const compose = JSON.parse(await readFile(resolve(directory, "compose.json"), "utf8"));
    expect(compose.services.postgres.ports).toEqual(["127.0.0.1:55433:5432"]);
    expect(compose.services.postgres.restart).toBe("unless-stopped");
    expect(compose.services.postgres.mem_limit).toBe("1g");
    expect(compose.services.postgres.cpus).toBe(1);
    expect(compose.volumes.data.name).toBe(volumeName);
    await setupServices({
      directory,
      migrate,
      execute: engine((command) =>
        command.includes("ls")
          ? { code: 0, out: volumeName }
          : command.includes("volume") && command.includes("inspect")
            ? { code: 0, out: first.instance }
            : undefined,
      ),
    });
    expect(await readService(directory)).toEqual(first);
    expect(first).toMatchObject({ engineId: "test-engine", initialized: true });
    expect(migrate).toHaveBeenCalledWith(databaseUrl(first));
    expect(await readdir(directory)).not.toContain("setup.lock");
  } finally {
    await f.dispose();
  }
});
it("refuses orphan volumes and ownership conflicts before migration or compose up", async () => {
  const f = await fixture({});
  try {
    const directory = resolve(f.root, "service"),
      migrate = vi.fn();
    const execute = engine((command) =>
      command.includes("ls") ? { code: 0, out: volumeName } : undefined,
    );
    await expect(setupServices({ directory, execute, migrate })).rejects.toThrow(
      "without its credentials",
    );
    await createService(directory);
    await expect(setupServices({ directory, execute, migrate })).rejects.toThrow(
      "ownership mismatch",
    );
    expect(migrate).not.toHaveBeenCalled();
    expect(execute.mock.calls.some(([c]) => c.includes("up"))).toBe(false);
  } finally {
    await f.dispose();
  }
});
it("preserves state and unlocks after a failed startup or migration", async () => {
  const f = await fixture({});
  try {
    const directory = resolve(f.root, "service"),
      migrate = vi.fn();
    await expect(
      setupServices({
        directory,
        migrate,
        execute: engine((c) => (c.includes("up") ? { code: 1, out: "" } : undefined)),
      }),
    ).rejects.toThrow("startup failed");
    expect(migrate).not.toHaveBeenCalled();
    const state = await readService(directory);
    await expect(
      setupServices({
        directory,
        execute: engine(),
        migrate: async () => {
          throw new Error("migration failed");
        },
      }),
    ).rejects.toThrow("migration failed");
    expect(await readService(directory)).toEqual(state);
    expect(await readdir(directory)).not.toContain("setup.lock");
  } finally {
    await f.dispose();
  }
});
it("rejects symlinks and concurrent setup locks", async () => {
  const f = await fixture({});
  try {
    const directory = resolve(f.root, "service");
    await mkdir(directory);
    await mkdir(resolve(directory, "setup.lock"));
    await expect(setupServices({ directory, execute: engine() })).rejects.toThrow("Another setup");
    const redirect = resolve(f.root, "redirect");
    await symlink(directory, redirect);
    await expect(createService(redirect)).rejects.toThrow("symbolic links");
  } finally {
    await f.dispose();
  }
});
it.each(["darwin", "linux", "win32"] as const)(
  "prepares Docker on %s and waits before querying it",
  async (platform) => {
    let prepared = false;
    const execute = engine((command) => {
      if (command[0] === "sh" || command[0] === "powershell.exe") {
        prepared = true;
        return { code: 0, out: "" };
      }
      if (command.includes("info") && !prepared) return { code: 1, out: "" };
      return undefined;
    });
    await ensureDocker(execute, platform);
    expect(prepared).toBe(true);
  },
);
it("stops on reboot-required/helper failure and refuses remote engines", async () => {
  await expect(
    ensureDocker(
      engine((c) =>
        c.includes("info") || c[0] === "powershell.exe" ? { code: 1, out: "" } : undefined,
      ),
      "win32",
    ),
  ).rejects.toThrow("incomplete");
  await expect(
    ensureDocker(
      engine((c) => (c.includes("context") ? { code: 0, out: "ssh://host" } : undefined)),
    ),
  ).rejects.toThrow("local Docker context");
  vi.stubEnv("DOCKER_HOST", "tcp://remote:2375");
  const execute = engine();
  await expect(ensureDocker(execute)).rejects.toThrow("remote DOCKER_HOST");
  expect(execute).not.toHaveBeenCalled();
});
it("starts the selected OrbStack context without invoking the Docker Desktop installer", async () => {
  let prepared = false;
  const execute = engine((command) => {
    if (command.includes("show")) return { code: 0, out: "orbstack\n" };
    if (command.includes("inspect") && command.includes("context"))
      return { code: 0, out: "unix:///Users/test/.orbstack/run/docker.sock\n" };
    if (command[0] === "sh") {
      prepared = true;
      return { code: 0, out: "" };
    }
    if (command.includes("info") && !prepared) return { code: 1, out: "" };
    return undefined;
  });
  await ensureDocker(execute, "darwin");
  expect(execute.mock.calls.find(([command]) => command[0] === "sh")?.[0].at(-1)).toBe("orbstack");
});
it("refuses a different engine or a missing completed volume before Compose starts", async () => {
  const f = await fixture({});
  try {
    const directory = resolve(f.root, "service");
    const first = engine();
    await setupServices({ directory, execute: first, migrate: async () => {} });
    const missing = engine();
    await expect(
      setupServices({ directory, execute: missing, migrate: async () => {} }),
    ).rejects.toThrow("volume is missing");
    expect(missing.mock.calls.some(([command]) => command.includes("up"))).toBe(false);
    const other = engine((command) =>
      command.includes("{{.ID}}") ? { code: 0, out: "another-engine\n" } : undefined,
    );
    await expect(
      setupServices({ directory, execute: other, migrate: async () => {} }),
    ).rejects.toThrow("another Docker engine");
    expect(other.mock.calls.some(([command]) => command.includes("up"))).toBe(false);
  } finally {
    await f.dispose();
  }
});
it("starts a fresh engine only when requested and keeps the previous credentials", async () => {
  const f = await fixture({});
  try {
    const directory = resolve(f.root, "service");
    await setupServices({ directory, execute: engine(), migrate: async () => {} });
    const old = await readService(directory);
    const other = engine((command) =>
      command.includes("info") && command.includes("{{.ID}}")
        ? { code: 0, out: "new-engine\n" }
        : undefined,
    );
    await setupServices({ directory, execute: other, migrate: async () => {}, freshEngine: true });
    expect(await readService(directory)).toMatchObject({
      engineId: "new-engine",
      initialized: true,
    });
    expect(
      JSON.parse(await readFile(resolve(directory, `service.${old.instance}.json`), "utf8")),
    ).toEqual(old);
    expect((await readService(directory)).instance).not.toBe(old.instance);
  } finally {
    await f.dispose();
  }
});
it("generates no destructive commands or external database target", async () => {
  const f = await fixture({});
  try {
    const state = await createService(f.root);
    expect(composeDefinition(state).services.postgres.image).toBe("pgvector/pgvector:pg17");
    expect(databaseUrl(state)).toMatch(/@127\.0\.0\.1:55433\/codememory$/);
  } finally {
    await f.dispose();
  }
});

it("bounds engine waiting by elapsed time instead of an unbounded retry duration", async () => {
  let elapsed = 0;
  vi.spyOn(Date, "now").mockImplementation(() => elapsed);
  vi.stubGlobal("Bun", {
    which: () => "docker",
    sleep: async () => {
      elapsed += 60000;
    },
  });
  const execute = engine((c) => (c.includes("info") ? { code: 1, out: "" } : undefined));
  await expect(ensureDocker(execute, "darwin")).rejects.toThrow("180 seconds");
  expect(execute.mock.calls.filter(([c]) => c.includes("info")).length).toBeLessThanOrEqual(4);
});
it("explicit restart recreates only the validated managed service and preserves its volume", async () => {
  const f = await fixture({});
  try {
    const execute = engine();
    await setupServices({
      directory: resolve(f.root, "service"),
      execute,
      migrate: async () => {},
      restart: true,
    });
    const commands = execute.mock.calls.map(([command]) => command);
    expect(
      commands.some((command) => command.includes("up") && command.includes("--force-recreate")),
    ).toBe(true);
    expect(
      commands.some((command) => command.includes("down") || command.includes("--volumes")),
    ).toBe(false);
  } finally {
    await f.dispose();
  }
});

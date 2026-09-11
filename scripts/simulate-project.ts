import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { CodebaseService } from "@codememory/application";
import type { LanguagePlugin } from "@codememory/core";
import { IndexService, ProjectSession, RepositoryScanner } from "@codememory/indexer";
import { ProcessTypeScriptPlugin } from "@codememory/plugin-typescript/process";
import { contains, createProjectContext, hash } from "@codememory/shared";
import { eventually, fixture, testDatabase } from "@codememory/test-utils";

// Only this repository can be selected. Mutations are confined to its temporary copy.
const seconds = Number(process.argv[2] ?? 300);
assert(
  Number.isInteger(seconds) && seconds >= 10 && seconds <= 86400,
  "Duration must be 10..86400 seconds",
);
const exec = promisify(execFile);
const source = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const revision = (await exec("git", ["rev-parse", "HEAD"], { cwd: source })).stdout.trim();
const tracked = (await exec("git", ["ls-files", "-z"], { cwd: source })).stdout
  .split("\0")
  .filter(Boolean);
const f = await fixture({});
let db: Awaited<ReturnType<typeof testDatabase>> | undefined;
let session: ProjectSession | undefined;
let sampling: Promise<void> | undefined;
let peakSampledRssBytes = 0;
let samples = 0;
let sampleErrors = 0;
const sample = async () => {
  try {
    const rows = (await exec("ps", ["-axo", "pid=,ppid=,rss="])).stdout
      .trim()
      .split("\n")
      .map((line) => line.trim().split(/\s+/).map(Number));
    const pids = new Set([process.pid]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const [pid, parent] of rows)
        if (pid !== undefined && parent !== undefined && pids.has(parent) && !pids.has(pid)) {
          pids.add(pid);
          changed = true;
        }
    }
    const rss = rows.reduce(
      (sum, [pid, , kb]) => sum + (pid !== undefined && pids.has(pid) ? (kb ?? 0) * 1024 : 0),
      0,
    );
    peakSampledRssBytes = Math.max(peakSampledRssBytes, rss);
    samples++;
  } catch {
    sampleErrors++;
  }
};
const timer = setInterval(() => {
  if (!sampling)
    sampling = sample().finally(() => {
      sampling = undefined;
    });
}, 500);
const emit = (data: unknown) => console.log(JSON.stringify(data));
try {
  const originalHashes = new Map<string, string>();
  for (const path of tracked) {
    const from = resolve(source, path),
      to = resolve(f.root, path);
    assert(contains(source, from) && contains(f.root, to));
    assert((await lstat(from)).isFile(), "Simulation requires regular tracked files");
    originalHashes.set(path, hash(await readFile(from)));
    await mkdir(dirname(to), { recursive: true });
    await copyFile(from, to);
  }
  const context = await createProjectContext(f.root);
  const c = {
    ...context,
    effectiveConfig: { ...context.effectiveConfig, debounceMs: 100, reconcileMs: 1000 },
  };
  db = await testDatabase();
  const store = db.store;
  const parser = new ProcessTypeScriptPlugin();
  let fail = false;
  const plugin: LanguagePlugin = {
    id: parser.id,
    version: parser.version,
    extensions: parser.extensions,
    analyze: (...args) => {
      if (fail) throw new Error("Simulated parser failure");
      return parser.analyze(...args);
    },
  };
  const index = new IndexService(c, store, new RepositoryScanner(), plugin);
  const open = () => new ProjectSession(c, store, index, true, true);
  const service = new CodebaseService(c, store);
  await store.register(c);
  const start = performance.now();
  await index.index();
  const initialMs = performance.now() - start;
  const baseline = await store.snapshot(c);
  const memory = await service.memory.remember({
    type: "NOTE",
    title: "Simulation retention",
    content: "Preserve across watcher restarts",
  });
  const probe = "scripts/codememory-simulation-probe.ts";
  assert(!tracked.includes(probe));
  let rounds = 0,
    failures = 0,
    restarts = 0;
  const convergenceMs: number[] = [],
    searchMs: number[] = [];
  session = open();
  await session.start();
  const exerciseStart = performance.now();
  emit({
    event: "simulation_started",
    revision,
    trackedFiles: tracked.length,
    indexedFiles: baseline.files.length,
    symbols: baseline.symbols.length,
    edges: baseline.edges.length,
    initialMs,
    requestedSeconds: seconds,
  });
  do {
    const roundStart = performance.now();
    rounds++;
    const name = `simulationRevision${rounds}`;
    fail = rounds % 5 === 0;
    const beforeVersion = (await store.snapshot(c)).version;
    await writeFile(
      resolve(f.root, probe),
      `export function ${name}(){return ${rounds}}\nexport function simulationCaller(){return ${name}()}\n`,
    );
    if (fail) {
      await eventually(async () => {
        const status = await session?.status();
        return status?.state === "ERROR" && status.pendingChanges === 0;
      }, 150000);
      assert.equal((await store.snapshot(c)).version, beforeVersion);
      failures++;
      fail = false;
    }
    await eventually(async () => {
      const result = await service.execute("search_symbols", { query: name, limit: 10 });
      return (result.results as { name: string }[]).some((s) => s.name === name);
    }, 150000);
    const snapshot = await store.snapshot(c);
    const caller = snapshot.symbols.find((s) => s.file === probe && s.name === "simulationCaller");
    const target = snapshot.symbols.find((s) => s.file === probe && s.name === name);
    assert(caller && target);
    assert(
      snapshot.edges.some(
        (e) => e.type === "CALLS" && e.source === caller.id && e.target === target.id,
      ),
    );
    assert.equal(
      snapshot.symbols.filter((s) => s.file === probe && s.kind === "FUNCTION").length,
      2,
    );
    const ids = new Set(snapshot.symbols.map((s) => s.id));
    assert(snapshot.edges.every((e) => ids.has(e.source) && ids.has(e.target)));
    convergenceMs.push(performance.now() - roundStart);
    const queryStart = performance.now();
    const result = await service.execute("search_symbols", {
      query: "createProjectContext",
      limit: 10,
    });
    assert((result.results as { name: string }[]).some((s) => s.name === "createProjectContext"));
    searchMs.push(performance.now() - queryStart);
    if (rounds % 3 === 0) {
      await session.close();
      await rename(resolve(f.root, probe), resolve(f.root, `${probe}.bak`));
      session = open();
      await session.start();
      await eventually(
        async () => !(await store.snapshot(c)).files.some((file) => file.path === probe),
        150000,
      );
      await rm(resolve(f.root, `${probe}.bak`));
      restarts++;
    }
    assert(
      (await service.memory.search("Simulation retention")).results.some(
        (item) => item.id === memory.id,
      ),
    );
    emit({
      event: "simulation_round",
      round: rounds,
      convergenceMs: convergenceMs.at(-1),
      searchMs: searchMs.at(-1),
      failures,
      restarts,
      peakSampledRssBytes,
    });
    // Pace changes to avoid running the compiler continuously on a small machine.
    await new Promise((done) => setTimeout(done, 5000));
  } while (performance.now() - exerciseStart < seconds * 1000);
  await session.close();
  await rm(resolve(f.root, probe), { force: true });
  await index.index();
  const final = await store.snapshot(c);
  // Removing the probe must restore the entire original graph, not just its counts.
  for (const key of ["files", "symbols", "edges", "unresolved", "diagnostics"] as const) {
    const normalized = (values: readonly unknown[]) =>
      values.map((value) => JSON.stringify(value)).sort();
    assert.deepEqual(
      normalized(final[key]),
      normalized(baseline[key]),
      `Final ${key} differs from baseline`,
    );
  }
  const noopStart = performance.now();
  assert.equal((await index.index()).reason, "UNCHANGED");
  const unchangedMs = performance.now() - noopStart;
  for (const [path, expected] of originalHashes)
    assert.equal(
      hash(await readFile(resolve(source, path))),
      expected,
      "Source checkout changed during simulation",
    );
  await sample();
  emit({
    event: "simulation_complete",
    revision,
    elapsedMs: performance.now() - start,
    rounds,
    failures,
    restarts,
    initialMs,
    unchangedMs,
    maxConvergenceMs: Math.max(...convergenceMs),
    maxSearchMs: Math.max(...searchMs),
    peakSampledRssBytes,
    samples,
    sampleErrors,
    memoryScope:
      "500ms sampled parent plus descendants RSS; excludes PostgreSQL; may miss peaks and double-count shared pages",
    baselineGraphRestored: true,
    sourceCheckoutUnchanged: true,
  });
} finally {
  clearInterval(timer);
  await sampling;
  await session?.close();
  await db?.dispose();
  await f.dispose();
}

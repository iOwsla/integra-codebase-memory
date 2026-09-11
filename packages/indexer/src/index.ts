import type {
  FileScanner,
  IndexResult,
  LanguagePlugin,
  ProjectContext,
  ProjectStore,
} from "@codememory/core";
import { CodeMemoryError } from "@codememory/core";
import { hash, log } from "@codememory/shared";
import chokidar, { type FSWatcher } from "chokidar";
import { watchPolicy } from "./watch-policy";

export { RepositoryScanner } from "./scanner";
export class IndexService {
  constructor(
    readonly context: ProjectContext,
    private readonly store: ProjectStore,
    private readonly scanner: FileScanner,
    private readonly plugin: LanguagePlugin,
  ) {}
  async index(force = false): Promise<IndexResult> {
    return this.store.locked(this.context, async (store) => {
      const old = await store.snapshot(this.context);
      const scan = await this.scanner.scan(this.context);
      const fingerprint = hash(
        JSON.stringify([
          this.context.indexVersion,
          this.plugin.version,
          this.context.effectiveConfig,
          [...scan.configs].sort(),
        ]),
      );
      const before = new Map(old.files.map((f) => [f.path, f]));
      const changed = scan.files
        .filter(
          (f) =>
            force ||
            fingerprint !== old.fingerprint ||
            before.get(f.path)?.hash !== f.hash ||
            before.get(f.path)?.status !== f.status,
        )
        .map((f) => f.path);
      const paths = new Set(scan.files.map((f) => f.path));
      const deleted = old.files.filter((f) => !paths.has(f.path)).map((f) => f.path);
      if (old.version > 0 && !changed.length && !deleted.length && old.fingerprint === fingerprint)
        return {
          version: old.version,
          changed: 0,
          deleted: 0,
          excluded: scan.excluded,
          reason: "UNCHANGED",
          indexedAt: old.indexedAt,
        };
      const reason = force
        ? "FORCED"
        : old.version === 0
          ? "INITIAL"
          : fingerprint !== old.fingerprint
            ? "PARSER_CONFIG_SCHEMA_CHANGED"
            : "PROJECT_SEMANTIC_REANALYSIS: dependency impact cannot yet be bounded safely";
      const started = Date.now();
      const analysis = await this.plugin.analyze(this.context, scan.files, scan.configs);
      const indexedAt = new Date().toISOString();
      const result = {
        version: old.version + 1,
        changed: changed.length,
        deleted: deleted.length,
        excluded: scan.excluded,
        reason,
        indexedAt,
      };
      await store.publish(
        this.context,
        { ...analysis, files: scan.files, version: result.version, fingerprint, indexedAt },
        changed,
        deleted,
        result,
      );
      log("info", "index_completed", {
        scope: this.context.projectScopeId,
        sessionId: this.context.sessionId,
        durationMs: Date.now() - started,
        ...result,
      });
      return result;
    });
  }
}
export class ProjectSession {
  private watcher?: FSWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private reconcile?: ReturnType<typeof setInterval>;
  private running?: Promise<void>;
  private closing = false;
  private pending = new Set<string>();
  private lastError?: string;
  private lastResult?: IndexResult;
  private stopped?: Promise<void>;
  constructor(
    readonly context: ProjectContext,
    private readonly store: ProjectStore,
    private readonly indexer: IndexService,
    readonly autoIndex: boolean,
    readonly watch: boolean,
    private readonly observe: (event: string, path: string) => void = () => {},
  ) {}
  async start() {
    await this.store.register(this.context);
    if (this.closing) return;
    if (this.watch) {
      this.observe("watch", this.context.canonicalRoot);
      this.watcher = chokidar.watch(this.context.canonicalRoot, {
        ignoreInitial: true,
        followSymlinks: false,
        ignored: watchPolicy(this.context),
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      });
      this.watcher.on("all", (_event, path) => this.schedule(path));
      this.watcher.on("error", () => {
        this.lastError = "WATCH_ERROR";
      });

      this.reconcile = setInterval(
        () => this.schedule("reconcile"),
        this.context.effectiveConfig.reconcileMs,
      );
    }
    if (this.autoIndex) this.schedule("initial", 0);
  }
  private schedule(path: string, delay = this.context.effectiveConfig.debounceMs) {
    if (this.closing) return;
    this.pending.add(path);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.drain();
    }, delay);
  }
  private async drain() {
    if (this.closing || this.running) return;
    this.pending.clear();
    this.running = (async () => {
      try {
        this.lastResult = await this.indexer.index();
        this.lastError = undefined;
      } catch (e) {
        this.lastError = e instanceof CodeMemoryError ? e.code : "INDEX_ERROR";
        if (this.lastError === "INDEX_BUSY") this.schedule("lock-retry", 500);
        else await this.store.recordFailure(this.context, this.lastError).catch(() => {});
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = undefined;
      if (this.pending.size && !this.closing) this.schedule("queued");
    }
  }
  async status() {
    const persisted = await this.store.status(this.context);
    return {
      projectRoot: this.context.canonicalRoot,
      projectScopeId: this.context.projectScopeId,
      projectSource: "explicit --project",
      autoIndex: this.autoIndex,
      watcher: !!this.watcher && !this.closing,
      state: this.running
        ? "INDEXING"
        : this.lastError
          ? "ERROR"
          : persisted.version
            ? "READY"
            : "NEW",
      pendingChanges: this.pending.size,
      indexVersion: persisted.version ?? 0,
      indexedAt: persisted.indexed_at ?? null,
      freshness:
        this.running || this.pending.size
          ? "UPDATING"
          : persisted.version
            ? "LAST_COMPLETED"
            : "NOT_READY",
      incomplete: !persisted.version,
      excludedFiles: (persisted.last_run as IndexResult | undefined)?.excluded ?? 0,
      error: this.lastError,
      lastReanalysisReason:
        this.lastResult?.reason ?? (persisted.last_run as IndexResult | undefined)?.reason,
      ...persisted,
    };
  }
  async close() {
    if (this.stopped) return this.stopped;
    this.closing = true;
    this.stopped = (async () => {
      if (this.timer) clearTimeout(this.timer);
      if (this.reconcile) clearInterval(this.reconcile);
      this.pending.clear();
      await this.watcher?.close();
      await this.running;
    })();
    return this.stopped;
  }
}

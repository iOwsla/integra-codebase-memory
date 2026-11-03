import { type FSWatcher as NativeWatcher, watch as watchNative } from "node:fs";
import { basename, resolve } from "node:path";
import type {
  FileScanner,
  IndexProgress,
  IndexResult,
  LanguagePlugin,
  ProjectContext,
  ProjectStore,
  StatusOptions,
} from "@codememory/core";
import { CodeMemoryError } from "@codememory/core";
import { hash, log } from "@codememory/shared";
import chokidar, { type FSWatcher } from "chokidar";
import { watchPolicy } from "./watch-policy";

export { RepositoryScanner } from "./scanner";

/** Ignore rules already surface as added/deleted paths; hashing them would re-mark every file. */
const IGNORE_FILES = new Set([".gitignore", ".codememoryignore"]);
const cancelled = () => new CodeMemoryError("INDEX_CANCELLED", "Index job cancelled");
export class IndexService {
  constructor(
    readonly context: ProjectContext,
    private readonly store: ProjectStore,
    private readonly scanner: FileScanner,
    private readonly plugin: LanguagePlugin,
    private readonly observe?: (progress: Readonly<IndexProgress>) => void,
  ) {}
  async index(force = false, signal?: AbortSignal): Promise<IndexResult> {
    return this.store.locked(this.context, async (store) => {
      const progress: IndexProgress = {
        state: "RUNNING",
        stage: "SCANNING",
        startedAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      };
      const record = async () => {
        progress.updatedAt = new Date().toISOString();
        this.observe?.({ ...progress });
        await store.recordIndexProgress(this.context, progress);
      };
      await record();
      try {
        const old = await store.indexState(this.context);
        const scan = await this.scanner.scan(this.context, this.plugin.configurationReferences);
        for (const file of scan.files) file.parserVersion = this.plugin.version;
        const fingerprint = hash(
          JSON.stringify([
            this.context.indexVersion,
            this.plugin.version,
            {
              maxFileSizeBytes: this.context.effectiveConfig.maxFileSizeBytes,
              include: this.context.effectiveConfig.include,
              exclude: this.context.effectiveConfig.exclude,
              excludeGenerated: this.context.effectiveConfig.excludeGenerated,
            },
            [...scan.configs].filter(([path]) => !IGNORE_FILES.has(basename(path))).sort(),
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
        if (
          old.version > 0 &&
          !changed.length &&
          !deleted.length &&
          old.fingerprint === fingerprint
        ) {
          progress.state = "SUCCEEDED";
          progress.stage = "COMPLETE";
          progress.version = old.version;
          await record();
          return {
            version: old.version,
            changed: 0,
            deleted: 0,
            excluded: scan.excluded,
            exclusions: scan.exclusions,
            reason: "UNCHANGED",
            indexedAt: old.indexedAt,
          };
        }
        const reason = force
          ? "FORCED"
          : old.version === 0
            ? "INITIAL"
            : fingerprint !== old.fingerprint
              ? "PARSER_CONFIG_SCHEMA_CHANGED"
              : "PROJECT_SEMANTIC_REANALYSIS: dependency impact cannot yet be bounded safely";
        const started = Date.now();
        if (signal?.aborted) throw cancelled();
        progress.stage = "ANALYZING";
        await record();
        const analysis = await this.plugin.analyze(this.context, scan.files, scan.configs, signal);
        const indexedAt = new Date().toISOString();
        const result = {
          version: Math.max(old.version, old.versionFloor ?? 0) + 1,
          changed: changed.length,
          deleted: deleted.length,
          excluded: scan.excluded,
          exclusions: scan.exclusions,
          reason,
          indexedAt,
        };
        // Cancellation is honored only up to this point; a started publish always completes.
        if (signal?.aborted) throw cancelled();
        progress.stage = "PUBLISHING";
        await record();
        await store.publish(
          this.context,
          { ...analysis, files: scan.files, version: result.version, fingerprint, indexedAt },
          changed,
          deleted,
          result,
        );
        if (!this.observe)
          log("info", "index_completed", {
            scope: this.context.projectScopeId,
            sessionId: this.context.sessionId,
            durationMs: Date.now() - started,
            ...result,
          });
        progress.state = "SUCCEEDED";
        progress.stage = "COMPLETE";
        progress.version = result.version;
        await record();
        return result;
      } catch (error) {
        progress.state = "FAILED";
        progress.error = error instanceof CodeMemoryError ? error.code : "INDEX_ERROR";
        await record().catch(() => {});
        throw error;
      }
    });
  }
}
/** Schedules that only retry earlier work; they honor the failure backoff. */
const RETRY_REASONS = new Set(["reconcile", "queued", "lock-retry", "watch-error"]);
const MAX_FAILURE_BACKOFF_MS = 3600000;
const CONNECTION_ERROR_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ETIMEDOUT",
  "EHOSTUNREACH",
  "ENOTFOUND",
  "EPIPE",
  "57P01",
  "57P02",
  "57P03",
]);
/**
 * Errors that a later retry can succeed on without any source change: an unmigrated database
 * (fixed by setup) or an unavailable one. They must not wait out the exponential backoff.
 */
function environmentError(error: unknown) {
  if (error instanceof CodeMemoryError) return error.code === "SCHEMA_OUTDATED";
  const code = (error as { code?: unknown } | undefined)?.code;
  if (typeof code === "string" && (CONNECTION_ERROR_CODES.has(code) || code.startsWith("08")))
    return true;
  const message = error instanceof Error ? error.message : "";
  return /Connection terminated|timeout exceeded when trying to connect/i.test(message);
}
export class ProjectSession {
  private watcher?: FSWatcher | NativeWatcher;
  private timer?: ReturnType<typeof setTimeout>;
  private reconcile?: ReturnType<typeof setInterval>;
  private rearmTimer?: ReturnType<typeof setTimeout>;
  private running?: Promise<void>;
  private abort?: AbortController;
  private closing = false;
  private pending = new Set<string>();
  /** A real path event arrived after the current or last drain started. */
  private changeSinceDrain = false;
  private lastError?: string;
  private busyAttempts = 0;
  private retryNotBefore = 0;
  private failures = 0;
  private failureRetryNotBefore = 0;
  /** Watcher health is tracked apart from index errors so a later index cannot hide it. */
  private watchError?: { code: string; at: string };
  private watchAttempts = 0;
  private staleSince?: string;
  private lastErrorMessage?: string;
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
      if (!this.watcher) this.arm();
      this.reconcile ??= setInterval(
        () => this.schedule("reconcile"),
        this.context.effectiveConfig.reconcileMs,
      );
    }
    if (this.autoIndex) this.schedule("initial", 0);
  }
  private arm() {
    const ignored = watchPolicy(this.context);
    if (process.platform === "darwin") {
      const watcher = watchNative(
        this.context.canonicalRoot,
        { recursive: true },
        (_event, name) => {
          this.watchAttempts = 0;
          this.watchError = undefined;
          const path = name
            ? resolve(this.context.canonicalRoot, String(name))
            : this.context.canonicalRoot;
          if (!ignored(path)) this.schedule(path);
        },
      );
      // A native watcher stops delivering events after an error; replace it.
      watcher.on("error", (error) => {
        this.watchFailed(error);
        if (this.watcher !== watcher) return;
        this.watcher = undefined;
        try {
          watcher.close();
        } catch {}
        this.rearm();
      });
      this.watcher = watcher;
    } else {
      const watcher = chokidar.watch(this.context.canonicalRoot, {
        ignoreInitial: true,
        followSymlinks: false,
        ignored,
        awaitWriteFinish: { stabilityThreshold: 100, pollInterval: 25 },
      });
      // Chokidar never retries a path whose watch failed (ENOSPC, EMFILE, EACCES), so events
      // from the paths still watched must not clear the error: watching stays partial and the
      // affected area is only found by reconcile until the session restarts.
      watcher.on("all", (_event, path) => this.schedule(path));
      // Chokidar keeps running after non-fatal errors; record them and reconcile.
      watcher.on("error", (error) => this.watchFailed(error));
      this.watcher = watcher;
    }
  }
  private watchFailed(error: unknown) {
    if (this.closing) return;
    this.watchError = { code: errorCode(error), at: new Date().toISOString() };
    this.schedule("watch-error", 0);
  }
  private rearm() {
    if (this.closing) return;
    const delay = Math.min(60000, 1000 * 2 ** Math.min(this.watchAttempts++, 6));
    this.rearmTimer = setTimeout(() => {
      this.rearmTimer = undefined;
      if (this.closing) return;
      try {
        this.arm();
        this.watchError = undefined;
        // Changes made while the watcher was down are only found by a reconcile.
        this.schedule("watch-error", 0);
      } catch (error) {
        this.watchError = { code: errorCode(error), at: new Date().toISOString() };
        this.rearm();
      }
    }, delay);
  }
  private schedule(path: string, delay = this.context.effectiveConfig.debounceMs) {
    if (this.closing) return;
    const retry = RETRY_REASONS.has(path);
    if (!retry) {
      this.changeSinceDrain = true;
      this.failureRetryNotBefore = 0;
    }
    const now = Date.now();
    const backoff = this.changeSinceDrain ? 0 : this.failureRetryNotBefore;
    // A retry waiting out a failure backoff is not a pending change.
    if (!retry || backoff <= now) {
      this.pending.add(path);
      this.staleSince ??= new Date().toISOString();
    }
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(
      () => {
        this.timer = undefined;
        void this.drain();
      },
      Math.max(delay, this.retryNotBefore - now, backoff - now),
    );
  }
  private async drain() {
    if (this.closing || this.running) return;
    this.pending.clear();
    this.changeSinceDrain = false;
    const controller = new AbortController();
    this.abort = controller;
    this.running = (async () => {
      try {
        this.lastResult = await this.indexer.index(false, controller.signal);
        this.lastError = undefined;
        this.lastErrorMessage = undefined;
        this.busyAttempts = 0;
        this.retryNotBefore = 0;
        this.failures = 0;
        this.failureRetryNotBefore = 0;
        if (!this.pending.size) this.staleSince = undefined;
      } catch (e) {
        const code = e instanceof CodeMemoryError ? e.code : "INDEX_ERROR";
        // Cancellation by close() is not an index failure.
        if (this.closing || code === "INDEX_CANCELLED") return;
        this.lastErrorMessage =
          e instanceof CodeMemoryError && e.code === "PARSER_ERROR" ? e.message : undefined;
        this.lastError = code;
        if (this.lastError === "INDEX_BUSY") {
          const delay = Math.min(30000, 1000 * 2 ** Math.min(this.busyAttempts++, 5));
          this.retryNotBefore = Date.now() + delay;
          this.schedule("lock-retry", delay);
        } else if (environmentError(e)) {
          // Like BUSY, the cause is outside the source: retry once per reconcile interval so a
          // session recovers soon after the database is migrated or reachable again.
          const delay = this.context.effectiveConfig.reconcileMs;
          this.failureRetryNotBefore = Date.now() + delay;
          this.schedule("queued", delay);
          await this.store.recordFailure(this.context, this.lastError).catch(() => {});
        } else {
          // Unchanged input fails the same way; back off retries until a real change arrives.
          const delay =
            this.context.effectiveConfig.reconcileMs * 2 ** Math.min(this.failures++, 20);
          this.failureRetryNotBefore = Date.now() + Math.min(MAX_FAILURE_BACKOFF_MS, delay);
          await this.store.recordFailure(this.context, this.lastError).catch(() => {});
        }
      }
    })();
    try {
      await this.running;
    } finally {
      this.running = undefined;
      this.abort = undefined;
      if (this.pending.size && !this.closing && !this.timer) this.schedule("queued");
    }
  }
  /** In-memory freshness for query responses; performs no database access. */
  liveState() {
    return {
      pendingChanges: this.pending.size,
      running: !!this.running,
      staleSince: this.staleSince,
    };
  }
  async status(options?: StatusOptions) {
    const persisted = await this.store.status(this.context, options);
    const job = persisted.lastIndexJob as
      | { state?: string; lockActive?: boolean; sessionId?: string; startedAt?: string }
      | undefined;
    const externalJob =
      job?.state === "RUNNING" && job.lockActive && job.sessionId !== this.context.sessionId;
    const busy = this.lastError === "INDEX_BUSY" || !!externalJob;
    // A RUNNING row without its advisory lock is an interrupted job, not an update.
    const updating =
      !!this.running || this.pending.size > 0 || (job?.state === "RUNNING" && !!job.lockActive);
    const now = Date.now();
    return {
      ...persisted,
      projectRoot: this.context.canonicalRoot,
      projectScopeId: this.context.projectScopeId,
      projectSource: "explicit --project",
      autoIndex: this.autoIndex,
      watcher: !!this.watcher && !this.closing && !this.watchError,
      watchError: this.watchError,
      state: this.running
        ? "INDEXING"
        : busy
          ? "BUSY"
          : this.lastError
            ? "ERROR"
            : persisted.version
              ? "READY"
              : "NEW",
      pendingChanges: this.pending.size,
      indexVersion: persisted.version ?? 0,
      servedFromVersion: persisted.version ?? 0,
      indexedAt: persisted.indexed_at ?? null,
      freshness: updating ? "UPDATING" : persisted.version ? "LAST_COMPLETED" : "NOT_READY",
      incomplete: !!persisted.incomplete || updating,
      staleSince: updating ? (this.staleSince ?? job?.startedAt ?? null) : null,
      excludedFiles: (persisted.last_run as IndexResult | undefined)?.excluded ?? 0,
      error: busy ? undefined : this.lastError,
      retryAfterMs: busy
        ? Math.max(0, this.retryNotBefore - now)
        : this.lastError
          ? Math.max(0, this.failureRetryNotBefore - now)
          : undefined,
      errorMessage: this.lastErrorMessage,
      lastReanalysisReason:
        this.lastResult?.reason ?? (persisted.last_run as IndexResult | undefined)?.reason,
    };
  }
  async close() {
    if (this.stopped) return this.stopped;
    this.closing = true;
    // Cancel the in-flight index first so close() does not wait for a full analysis.
    this.abort?.abort();
    this.stopped = (async () => {
      if (this.timer) clearTimeout(this.timer);
      if (this.reconcile) clearInterval(this.reconcile);
      if (this.rearmTimer) clearTimeout(this.rearmTimer);
      this.pending.clear();
      await this.watcher?.close();
      await this.running;
    })();
    return this.stopped;
  }
}
function errorCode(error: unknown) {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" ? code : "WATCH_ERROR";
}

export { watchPolicy } from "./watch-policy";

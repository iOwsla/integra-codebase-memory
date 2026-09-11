import { relative } from "node:path";
import type { IndexProgress } from "@codememory/core";
import type { ParserProfileEvent } from "@codememory/plugin-typescript";

/** A single throttled stderr line; stdout remains the final machine-readable result. */
export class CliProgress {
  private started = Date.now();
  private last = 0;
  private text = "WAITING: connecting / acquiring index lock";
  private scanned = 0;
  private closed = false;
  private elapsedLabel = "elapsed";
  private timer?: ReturnType<typeof setInterval>;
  constructor(
    private readonly root: string,
    private readonly enabled = true,
    private readonly output: Pick<
      NodeJS.WriteStream,
      "write" | "isTTY" | "columns"
    > = process.stderr,
    heartbeat = true,
  ) {
    if (enabled) {
      this.render(true);
      if (heartbeat) this.timer = setInterval(() => this.render(), output.isTTY ? 200 : 2000);
      this.timer?.unref();
    }
  }
  private safe(value: string) {
    // File names can contain terminal escape/control characters.
    // biome-ignore lint/suspicious/noControlCharactersInRegex: Strip terminal controls from file names.
    return value.replace(/[\x00-\x1f\x7f-\x9f]/g, "?");
  }
  private render(force = false) {
    if (!this.enabled || this.closed) return;
    const now = Date.now();
    if (!force && now - this.last < (this.output.isTTY ? 100 : 2000)) return;
    this.last = now;
    const elapsed = ((now - this.started) / 1000).toFixed(1);
    const text = this.safe(`${this.text} | ${this.elapsedLabel} ${elapsed}s`);
    if (this.output.isTTY)
      this.output.write(
        `\r\x1b[2K${text.slice(0, Math.max(20, (this.output.columns || 100) - 1))}`,
      );
    else this.output.write(`${text}\n`);
  }
  stage = (event: Readonly<IndexProgress>) => {
    this.text = `${event.state} ${event.stage}${event.error ? `: ${event.error}` : ""}`;
    this.render(true);
  };
  scan = (event: "scan" | "read" | "hash", path: string) => {
    if (event !== "hash") return;
    this.scanned++;
    this.text = `SCANNING ${this.scanned} files | ${relative(this.root, path)}`;
    this.render();
  };
  parser = (event: ParserProfileEvent) => {
    this.text = `ANALYZING ${event.phase === "COMPLETE" ? "TRANSFERRING" : event.phase}${event.completedFiles !== undefined ? ` ${event.completedFiles} files` : ""}${event.file ? ` | ${event.file}` : ""}${event.edges !== undefined ? ` | ${event.edges} relationships` : ""}`;
    this.render();
  };
  status = (value: Record<string, unknown>) => {
    this.elapsedLabel = "watching";
    const job = value.lastIndexJob as Record<string, unknown> | undefined;
    this.text = `${job?.interrupted ? "INTERRUPTED" : (job?.state ?? "NEW")} ${job?.stage ?? ""} | ${value.files ?? 0} indexed files | ${value.symbols ?? 0} symbols | ${value.edges ?? 0} relationships`;
    this.render(true);
  };
  close() {
    if (this.closed) return;
    this.closed = true;
    if (this.timer) clearInterval(this.timer);
    if (this.enabled && this.output.isTTY) this.output.write("\n");
  }
}

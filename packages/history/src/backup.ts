import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, unlink } from "node:fs/promises";
import { CodeMemoryError, type HistoryBackupRecord, type HistoryStore } from "@codememory/core";
import { z } from "zod";

const rowSchema = z.object({ table: z.string(), row: z.record(z.string(), z.unknown()) }).strict();
const MAX_LINE = 2 * 1024 * 1024;
/** Scoped JSONL with a mandatory checksum footer. Backup contents are private project data. */
export async function writeHistoryBackup(db: HistoryStore, scope: string, path: string) {
  const file = await open(path, "wx", 0o600);
  let records = 0,
    bytes = 0;
  const digest = createHash("sha256");
  const write = async (value: unknown, hashed = true) => {
    const text = `${JSON.stringify(value)}\n`;
    if (Buffer.byteLength(text) > MAX_LINE)
      throw new CodeMemoryError("HISTORY_BACKUP_LIMIT", "One backup row exceeds 2 MiB");
    if (hashed) digest.update(text);
    bytes += Buffer.byteLength(text);
    await file.writeFile(text);
  };
  try {
    await write({ format: "codememory-history-1", projectScopeId: scope });
    await db.runExclusive(async (store) =>
      store.writeBackup(async (record) => {
        await write(record);
        records++;
      }),
    );
    await write({ checksum: digest.digest("hex"), records }, false);
    await file.sync();
    await file.close();
    return { records, bytes, format: "codememory-history-1" };
  } catch (e) {
    await file.close();
    await unlink(path);
    throw e;
  }
}
export async function restoreHistoryBackup(db: HistoryStore, scope: string, path: string) {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  async function* records(): AsyncGenerator<HistoryBackupRecord> {
    const digest = createHash("sha256");
    let count = 0,
      header = false,
      footer = false,
      buffer = Buffer.alloc(0);
    const parse = (line: Buffer) => {
      const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(line));
      if (!header) {
        if (value.format !== "codememory-history-1" || value.projectScopeId !== scope)
          throw new CodeMemoryError(
            "HISTORY_BACKUP_SCOPE",
            "Backup format or selected project does not match",
          );
        header = true;
        digest.update(line);
        return;
      }
      if (footer)
        throw new CodeMemoryError("HISTORY_BACKUP_CHECKSUM", "Unexpected data after backup footer");
      if ("checksum" in value) {
        if (value.checksum !== digest.digest("hex") || value.records !== count)
          throw new CodeMemoryError(
            "HISTORY_BACKUP_CHECKSUM",
            "Backup checksum or record count does not match",
          );
        footer = true;
        return;
      }
      digest.update(line);
      count++;
      return rowSchema.parse(value);
    };
    for await (const chunk of file.createReadStream({ autoClose: false, highWaterMark: 65536 })) {
      buffer = Buffer.concat([buffer, chunk as Buffer]);
      let end: number;
      while (true) {
        end = buffer.indexOf(10);
        if (end < 0) break;
        if (end + 1 > MAX_LINE)
          throw new CodeMemoryError("HISTORY_BACKUP_LIMIT", "Backup row exceeds limit");
        const record = parse(buffer.subarray(0, end + 1));
        buffer = buffer.subarray(end + 1);
        if (record) yield record;
      }
      if (buffer.length > MAX_LINE)
        throw new CodeMemoryError("HISTORY_BACKUP_LIMIT", "Backup row exceeds limit");
    }
    if (buffer.length || !header || !footer)
      throw new CodeMemoryError(
        "HISTORY_BACKUP_CHECKSUM",
        "Backup is incomplete; missing checksum footer",
      );
  }
  try {
    return {
      restored: await db.runExclusive((store) => store.restoreBackup(records())),
      collectionEnabled: false,
      providersEnabled: false,
    };
  } finally {
    await file.close();
  }
}

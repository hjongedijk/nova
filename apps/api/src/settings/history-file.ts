import fs from "node:fs";
import path from "node:path";
import { REVISION_ID } from "./request-input.js";

/** How hard a write is flushed: not at all, the file, or the file and its directory entry. */
export type Durability = "none" | "file" | "dir";

function fsyncPath(target: string): void {
  const fd = fs.openSync(target, "r");
  try {
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
}

/** Atomically replaces `file` with `value` as JSON, readable by the owner only. */
export function writePrivateJson(
  file: string,
  value: unknown,
  durability: Durability = "none",
  dirMode?: number,
): void {
  fs.mkdirSync(path.dirname(file), {
    recursive: true,
    ...(dirMode === undefined ? {} : { mode: dirMode }),
  });
  const temporary = `${file}.${process.pid}.tmp`;
  try {
    fs.writeFileSync(temporary, JSON.stringify(value), { mode: 0o600 });
    fs.chmodSync(temporary, 0o600);
    if (durability !== "none") fsyncPath(temporary);
    fs.renameSync(temporary, file);
    if (durability === "dir") fsyncPath(path.dirname(file));
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

/** A JSON array file, or an empty list when it is missing, unreadable or not an array. */
export function readJsonArray(file: string): unknown[] {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(file, "utf8"));
    return Array.isArray(value) ? value : [];
  } catch {
    return [];
  }
}

/** Optional `revertedFrom` field of a revision row (only well-formed revision ids survive). */
export const revertedFromField = (
  row: Record<string, unknown>,
  /** Some older histories accept any string here; pass false to keep that. */
  strict = true,
): { revertedFrom?: string } =>
  typeof row.revertedFrom === "string" &&
  (!strict || REVISION_ID.test(row.revertedFrom))
    ? { revertedFrom: row.revertedFrom }
    : {};

export interface HistoryOptions {
  /** Revisions kept on disk (default 100). */
  max?: number;
  /** Revisions returned by `list()` (default 50). */
  listLimit?: number;
  durability?: Durability;
  /** Mode for a data directory this file has to create. */
  dirMode?: number;
}

/**
 * Bounded, owner-only JSON revision file. A row survives reading when it has a
 * revision id and an ISO timestamp and `fields` accepts the rest of it.
 */
export class HistoryFile<T extends { id: string; at: string }> {
  private readonly max: number;
  private readonly listLimit: number;
  private readonly durability: Durability;
  private readonly dirMode: number | undefined;

  constructor(
    readonly file: string,
    private readonly fields: (
      row: Record<string, unknown>,
    ) => Omit<T, "id" | "at"> | undefined,
    options: HistoryOptions = {},
  ) {
    this.max = options.max ?? 100;
    this.listLimit = options.listLimit ?? 50;
    this.durability = options.durability ?? "none";
    this.dirMode = options.dirMode;
  }

  all(): T[] {
    try {
      return readJsonArray(this.file)
        .flatMap((raw): T[] => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
          const row = raw as Record<string, unknown>;
          if (
            typeof row.id !== "string" ||
            !REVISION_ID.test(row.id) ||
            typeof row.at !== "string" ||
            !Number.isFinite(Date.parse(row.at))
          )
            return [];
          const rest = this.fields(row);
          return rest
            ? [{ id: row.id, at: new Date(row.at).toISOString(), ...rest } as T]
            : [];
        })
        .slice(-this.max);
    } catch {
      return [];
    }
  }

  write(rows: T[]): void {
    writePrivateJson(
      this.file,
      rows.slice(-this.max),
      this.durability,
      this.dirMode,
    );
  }

  append(revision: T): void {
    this.write([...this.all(), revision]);
  }

  find(id: string): T | undefined {
    return this.all().find((row) => row.id === id);
  }

  list(): { revisions: T[]; truncated: boolean } {
    return listRecent(this.all(), this.listLimit);
  }
}

/** Newest first, with a flag when older revisions were left out. */
export function listRecent<T>(
  rows: T[],
  limit = 50,
): { revisions: T[]; truncated: boolean } {
  return {
    revisions: rows.slice(-limit).reverse(),
    truncated: rows.length > limit,
  };
}

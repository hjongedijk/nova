import fs from "node:fs";
import path from "node:path";
import { importLegacyJson } from "../core/db/legacy-import.js";
import { novaDbFor, type NovaDb } from "../core/db/nova-db.js";
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
function readJsonArray(file: string): unknown[] {
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
 * Bounded revision log. Rows live in `nova.db` (table `revisions`, one store per
 * file name) next to the file's old location; a legacy `<name>.json` is imported
 * once and renamed `*.migrated`. When the database cannot be opened it falls
 * back to the owner-only JSON file it replaced. A row survives reading when it
 * has a revision id and an ISO timestamp and `fields` accepts the rest of it.
 */
export class HistoryFile<T extends { id: string; at: string }> {
  private readonly max: number;
  private readonly listLimit: number;
  private readonly durability: Durability;
  private readonly dirMode: number | undefined;
  private readonly store: string;

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
    this.store = path.basename(file);
  }

  /** The database, with this file's legacy JSON folded in; undefined = JSON fallback. */
  private db(): NovaDb | undefined {
    const db = novaDbFor(path.dirname(this.file), {
      ...(this.dirMode === undefined ? {} : { dirMode: this.dirMode }),
    });
    if (!db) return undefined;
    importLegacyJson(db, `revisions:${this.store}`, this.file, (parsed) => {
      const rows = (Array.isArray(parsed) ? parsed : []).flatMap(
        (raw): StoredRow[] =>
          raw &&
          typeof raw === "object" &&
          typeof (raw as { id?: unknown }).id === "string" &&
          typeof (raw as { at?: unknown }).at === "string"
            ? [
                {
                  id: (raw as { id: string }).id,
                  at: (raw as { at: string }).at,
                  json: JSON.stringify(raw),
                },
              ]
            : [],
      );
      const kept = rows.slice(-this.max);
      const present = db.revisions(this.store);
      const known = new Set(present.map((row) => row.id));
      db.replaceRevisions(
        this.store,
        [...present, ...kept.filter((row) => !known.has(row.id))],
        this.max,
      );
      return kept.length;
    });
    return db;
  }

  private parse(rows: unknown[]): T[] {
    return rows
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
  }

  all(): T[] {
    try {
      const db = this.db();
      if (!db) return this.parse(readJsonArray(this.file));
      return this.parse(
        db.revisions(this.store).flatMap((row) => {
          try {
            return [JSON.parse(row.json) as unknown];
          } catch {
            return [];
          }
        }),
      );
    } catch {
      return [];
    }
  }

  write(rows: T[]): void {
    const db = this.db();
    if (!db) {
      writePrivateJson(
        this.file,
        rows.slice(-this.max),
        this.durability,
        this.dirMode,
      );
      return;
    }
    db.replaceRevisions(this.store, rows.map(toStored), this.max);
  }

  append(revision: T): void {
    const db = this.db();
    if (!db) {
      this.write([...this.all(), revision]);
      return;
    }
    db.appendRevision(this.store, toStored(revision), this.max);
  }

  find(id: string): T | undefined {
    return this.all().find((row) => row.id === id);
  }

  list(): { revisions: T[]; truncated: boolean } {
    return listRecent(this.all(), this.listLimit);
  }
}

type StoredRow = { id: string; at: string; json: string };
const toStored = (row: { id: string; at: string }): StoredRow => ({
  id: row.id,
  at: row.at,
  json: JSON.stringify(row),
});

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

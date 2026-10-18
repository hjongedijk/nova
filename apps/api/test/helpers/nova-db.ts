import fs from "node:fs";
import path from "node:path";
import { vi } from "vitest";
import {
  deleteJsonState,
  readJsonState,
  writeJsonState,
} from "../../src/core/db/json-state.js";
import { NovaDb, novaDbFor } from "../../src/core/db/nova-db.js";

/** Stat of nova.db, standing in for the old per-store JSON file's stat. */
export function dbStat(fileOrDir: string): fs.Stats {
  const dir = path.extname(fileOrDir) ? path.dirname(fileOrDir) : fileOrDir;
  return fs.statSync(path.join(dir, "nova.db"));
}

/** The revision rows a history file (by its legacy path) now holds. */
export function historyRows(file: string): unknown[] {
  const db = novaDbFor(path.dirname(file));
  return (db?.revisions(path.basename(file)) ?? []).map((row) =>
    JSON.parse(row.json),
  );
}

/** JSON text of the stored rows, for leak assertions like `not.toContain(secret)`. */
export function historyText(file: string): string {
  return JSON.stringify(historyRows(file));
}

/** Empties one history store (what deleting the old JSON file used to do). */
export function clearHistory(file: string): void {
  novaDbFor(path.dirname(file))?.replaceRevisions(path.basename(file), [], 1);
}

/** The audit log as the old JSON-lines text, oldest first. */
export function auditText(dir: string): string {
  const db = novaDbFor(dir);
  return (db?.recentAudit(10_000) ?? []).reverse().join("\n") + "\n";
}

/** Rewrites a store's rows (for tests that tamper with stored history). */
export function setHistoryRows(
  file: string,
  rows: { id: string; at: string }[],
): void {
  novaDbFor(path.dirname(file))?.replaceRevisions(
    path.basename(file),
    rows.map((row) => ({ id: row.id, at: row.at, json: JSON.stringify(row) })),
    100,
  );
}

// --- small JSON state documents (progress, attempts, feeds, focus) ----------

/** The stored document for a legacy state-file path, or undefined. */
export function stateDoc(file: string): unknown {
  return readJsonState(file);
}

/** Text form of the stored document (a raw string stays as it is). */
export function stateText(file: string): string {
  const doc = readJsonState(file);
  return typeof doc === "string" ? doc : JSON.stringify(doc);
}

export function stateExists(file: string): boolean {
  return readJsonState(file) !== undefined;
}

/** Stores a document directly (use a non-object string to simulate damaged state). */
export function seedState(file: string, value: unknown): void {
  writeJsonState(file, value);
}

export function dropState(file: string): void {
  deleteJsonState(file);
}

/**
 * Makes every database write of the given state document throw until the
 * returned spy is restored — the equivalent of a failing rename before.
 */
export function failStateWrites(file: string, message = "write failed") {
  const key = path.basename(file);
  const original = NovaDb.prototype.kvSet;
  return vi.spyOn(NovaDb.prototype, "kvSet").mockImplementation(function (
    this: NovaDb,
    ns: string,
    k: string,
    value: unknown,
  ) {
    if (k === key) throw new Error(message);
    return original.call(this, ns, k, value);
  });
}

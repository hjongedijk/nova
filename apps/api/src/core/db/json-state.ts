import fs from "node:fs";
import path from "node:path";
import {
  writePrivateJson,
  type Durability,
} from "../../settings/history-file.js";
import { importLegacyJson } from "./legacy-import.js";
import { novaDbFor } from "./nova-db.js";

const NAMESPACE = "state";

/**
 * A small private JSON document addressed by its old file path
 * (`<dataDir>/small-thing.json`). It lives in `nova.db` (kv namespace "state",
 * key = file name); the old file is imported once and renamed `*.migrated`.
 * When the database is unavailable the very same file is read and written as
 * JSON, so behaviour degrades instead of failing.
 */
export function readJsonState(file: string): unknown | undefined {
  const db = novaDbFor(path.dirname(file));
  if (!db) {
    try {
      return JSON.parse(fs.readFileSync(file, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  }
  const key = path.basename(file);
  importLegacyJson(db, `state:${key}`, file, (parsed) => {
    db.kvAdd(NAMESPACE, key, parsed);
    return 1;
  });
  return db.kvGet(NAMESPACE, key);
}

export function writeJsonState(
  file: string,
  value: unknown,
  durability: Durability = "none",
): void {
  const db = novaDbFor(path.dirname(file));
  if (!db) {
    writePrivateJson(file, value, durability);
    return;
  }
  // Fold a not-yet-imported legacy file in first so it cannot resurface later.
  readJsonState(file);
  db.kvSet(NAMESPACE, path.basename(file), value);
}

export function deleteJsonState(file: string): void {
  const db = novaDbFor(path.dirname(file));
  if (!db) {
    fs.rmSync(file, { force: true });
    return;
  }
  readJsonState(file);
  db.kvDelete(NAMESPACE, path.basename(file));
}

/**
 * Drop-in for `JSON.parse(fs.readFileSync(file, "utf8"))` in code that treats
 * a missing file (`code === "ENOENT"`) as "no state yet": a missing document
 * throws that same error.
 */
export function readJsonStateOrEnoent(file: string): unknown {
  const value = readJsonState(file);
  if (value === undefined)
    throw Object.assign(new Error(`ENOENT: no stored state for ${file}`), {
      code: "ENOENT",
    });
  return value;
}

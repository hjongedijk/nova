import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import { closeNovaDb, DB_FILE_NAME, novaDbFor } from "./nova-db.js";

/** Names of nova.db and its SQLite companions, which a file-level backup must never copy live. */
export const DB_LIVE_FILES = [
  DB_FILE_NAME,
  `${DB_FILE_NAME}-wal`,
  `${DB_FILE_NAME}-shm`,
  `${DB_FILE_NAME}-journal`,
] as const;

/**
 * Writes a consistent, WAL-free copy of the data directory's nova.db to
 * `destination` with VACUUM INTO (the destination must not exist). Returns
 * false when the directory has no database. Throws when it has one that
 * cannot be opened: a backup must not silently omit it.
 */
export function snapshotDatabase(
  dataDir: string,
  destination: string,
): boolean {
  if (!fs.existsSync(path.join(dataDir, DB_FILE_NAME))) return false;
  const db = novaDbFor(dataDir);
  if (!db) throw new Error("nova.db cannot be opened for a backup");
  db.snapshotTo(destination);
  return true;
}

/**
 * Puts a snapshot back as the data directory's nova.db: the snapshot must pass
 * integrity_check, the live connection is closed, stale -wal/-shm files of the
 * replaced database are removed (they would corrupt the restored file), and the
 * file is swapped in atomically. The previous nova.db is kept as
 * `nova.db.before-restore`. Stop NOVA first when restoring over a running
 * instance; this only guards the connection of the current process.
 */
export function restoreDatabase(snapshot: string, dataDir: string): void {
  const probe = new DatabaseSync(snapshot, { readOnly: true });
  try {
    const row = probe.prepare("PRAGMA integrity_check").get() as
      { integrity_check?: string } | undefined;
    if (row?.integrity_check !== "ok")
      throw new Error("Snapshot failed integrity_check");
  } finally {
    probe.close();
  }
  closeNovaDb(dataDir);
  fs.mkdirSync(dataDir, { recursive: true });
  const target = path.join(dataDir, DB_FILE_NAME);
  const temporary = `${target}.${process.pid}.restore`;
  try {
    fs.copyFileSync(snapshot, temporary);
    fs.chmodSync(temporary, 0o600);
    const fd = fs.openSync(temporary, "r");
    try {
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    if (fs.existsSync(target))
      fs.renameSync(target, `${target}.before-restore`);
    fs.rmSync(`${target}-wal`, { force: true });
    fs.rmSync(`${target}-shm`, { force: true });
    fs.rmSync(`${target}-journal`, { force: true });
    fs.renameSync(temporary, target);
  } finally {
    fs.rmSync(temporary, { force: true });
  }
}

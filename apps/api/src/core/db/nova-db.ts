import fs from "node:fs";
import path from "node:path";
import { DatabaseSync, type SQLInputValue } from "node:sqlite";

/** The one SQLite file in the NOVA data directory. */
export const DB_FILE_NAME = "nova.db";

type Migration = { version: number; name: string; sql: string };

/**
 * Numbered, append-only migrations. Never edit a shipped entry; add a new one.
 * Each runs in its own transaction and is recorded in `schema_migrations`.
 */
export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "core tables: kv, revisions, audit, legacy_imports",
    sql: `
      CREATE TABLE legacy_imports (
        name TEXT PRIMARY KEY,
        imported_at TEXT NOT NULL,
        rows INTEGER NOT NULL
      );
      CREATE TABLE kv (
        ns TEXT NOT NULL,
        key TEXT NOT NULL,
        json TEXT NOT NULL,
        updated_at TEXT NOT NULL,
        PRIMARY KEY (ns, key)
      ) WITHOUT ROWID;
      CREATE TABLE revisions (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        store TEXT NOT NULL,
        id TEXT NOT NULL,
        at TEXT NOT NULL,
        json TEXT NOT NULL,
        UNIQUE (store, id)
      );
      CREATE TABLE audit (
        seq INTEGER PRIMARY KEY AUTOINCREMENT,
        id TEXT NOT NULL UNIQUE,
        ts TEXT NOT NULL,
        session_id TEXT,
        json TEXT NOT NULL
      );
      CREATE INDEX audit_session ON audit (session_id, seq);
    `,
  },
];

/** Newest audit rows kept; older ones are pruned in batches. */
export const AUDIT_MAX_ROWS = 200_000;
const AUDIT_PRUNE_EVERY = 500;

export interface StoredRevision {
  id: string;
  at: string;
  json: string;
}

const now = () => new Date().toISOString();

/** A typed, small facade over one `nova.db` connection (WAL, owner-only). */
export class NovaDb {
  private depth = 0;
  private auditWrites = 0;
  private closed = false;

  private constructor(
    readonly file: string,
    private readonly db: DatabaseSync,
  ) {}

  /** Opens (creating when needed) the database and applies pending migrations. */
  static open(
    file: string,
    options: { dirMode?: number; migrations?: readonly Migration[] } = {},
  ): NovaDb {
    fs.mkdirSync(path.dirname(file), {
      recursive: true,
      ...(options.dirMode === undefined ? {} : { mode: options.dirMode }),
    });
    // Create the file ourselves so it is 0600 from the first byte; SQLite gives
    // the -wal and -shm companions the same mode as the main file.
    fs.closeSync(fs.openSync(file, "a", 0o600));
    fs.chmodSync(file, 0o600);
    const db = new DatabaseSync(file);
    try {
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("PRAGMA journal_mode = WAL");
      db.exec("PRAGMA synchronous = FULL");
      db.exec("PRAGMA foreign_keys = ON");
      const handle = new NovaDb(file, db);
      handle.migrate(options.migrations ?? MIGRATIONS);
      return handle;
    } catch (error) {
      try {
        db.close();
      } catch {
        /* the original error matters */
      }
      throw error;
    }
  }

  private migrate(migrations: readonly Migration[]): void {
    this.db.exec(
      `CREATE TABLE IF NOT EXISTS schema_migrations (
        version INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TEXT NOT NULL
      )`,
    );
    const done = new Set(
      this.all<{ version: number }>(
        "SELECT version FROM schema_migrations",
      ).map((row) => row.version),
    );
    for (const migration of migrations) {
      if (done.has(migration.version)) continue;
      this.transaction(() => {
        this.db.exec(migration.sql);
        this.run(
          "INSERT INTO schema_migrations (version, name, applied_at) VALUES (?, ?, ?)",
          migration.version,
          migration.name,
          now(),
        );
      });
    }
  }

  get isOpen(): boolean {
    return !this.closed;
  }

  schemaVersion(): number {
    return (
      this.get<{ v: number | null }>(
        "SELECT MAX(version) AS v FROM schema_migrations",
      )?.v ?? 0
    );
  }

  run(sql: string, ...params: SQLInputValue[]): void {
    this.db.prepare(sql).run(...params);
  }

  get<T>(sql: string, ...params: SQLInputValue[]): T | undefined {
    return this.db.prepare(sql).get(...params) as T | undefined;
  }

  all<T>(sql: string, ...params: SQLInputValue[]): T[] {
    return this.db.prepare(sql).all(...params) as T[];
  }

  /**
   * All-or-nothing unit of work. Takes the write lock up front (BEGIN
   * IMMEDIATE) so concurrent writers queue on busy_timeout instead of failing
   * on lock upgrade; a nested call joins the outer transaction.
   */
  transaction<T>(work: () => T): T {
    if (this.depth > 0) return work();
    this.db.exec("BEGIN IMMEDIATE");
    this.depth = 1;
    try {
      const result = work();
      this.db.exec("COMMIT");
      return result;
    } catch (error) {
      try {
        this.db.exec("ROLLBACK");
      } catch {
        /* already rolled back */
      }
      throw error;
    } finally {
      this.depth = 0;
    }
  }

  // --- kv(namespace, key, json) ---------------------------------------

  kvGet<T = unknown>(ns: string, key: string): T | undefined {
    const row = this.get<{ json: string }>(
      "SELECT json FROM kv WHERE ns = ? AND key = ?",
      ns,
      key,
    );
    return row ? (JSON.parse(row.json) as T) : undefined;
  }

  kvHas(ns: string, key: string): boolean {
    return !!this.get(
      "SELECT 1 AS x FROM kv WHERE ns = ? AND key = ?",
      ns,
      key,
    );
  }

  kvSet(ns: string, key: string, value: unknown): void {
    this.run(
      `INSERT INTO kv (ns, key, json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (ns, key) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at`,
      ns,
      key,
      JSON.stringify(value),
      now(),
    );
  }

  /** Stores only when the key is absent; true when it was stored. */
  kvAdd(ns: string, key: string, value: unknown): boolean {
    const before = this.kvHas(ns, key);
    if (!before) this.kvSet(ns, key, value);
    return !before;
  }

  kvDelete(ns: string, key: string): void {
    this.run("DELETE FROM kv WHERE ns = ? AND key = ?", ns, key);
  }

  kvKeys(ns: string): string[] {
    return this.all<{ key: string }>(
      "SELECT key FROM kv WHERE ns = ? ORDER BY key",
      ns,
    ).map((row) => row.key);
  }

  // --- revisions(store, id, json, created) ------------------------------

  /** Oldest first. */
  revisions(store: string): StoredRevision[] {
    return this.all<StoredRevision>(
      "SELECT id, at, json FROM revisions WHERE store = ? ORDER BY seq",
      store,
    );
  }

  private trimRevisions(store: string, max: number): void {
    this.run(
      `DELETE FROM revisions WHERE store = ? AND seq NOT IN
         (SELECT seq FROM revisions WHERE store = ? ORDER BY seq DESC LIMIT ?)`,
      store,
      store,
      max,
    );
  }

  /** Adds (or replaces, by id) one revision and keeps the newest `max`. */
  appendRevision(store: string, row: StoredRevision, max: number): void {
    this.transaction(() => {
      this.run(
        "DELETE FROM revisions WHERE store = ? AND id = ?",
        store,
        row.id,
      );
      this.run(
        "INSERT INTO revisions (store, id, at, json) VALUES (?, ?, ?, ?)",
        store,
        row.id,
        row.at,
        row.json,
      );
      this.trimRevisions(store, max);
    });
  }

  /** Replaces the whole log (used for removals); keeps the newest `max`. */
  replaceRevisions(store: string, rows: StoredRevision[], max: number): void {
    this.transaction(() => {
      this.run("DELETE FROM revisions WHERE store = ?", store);
      for (const row of rows.slice(-max))
        this.run(
          "INSERT OR IGNORE INTO revisions (store, id, at, json) VALUES (?, ?, ?, ?)",
          store,
          row.id,
          row.at,
          row.json,
        );
    });
  }

  // --- audit -------------------------------------------------------------

  appendAudit(entry: {
    id: string;
    timestamp: string;
    sessionId?: unknown;
  }): void {
    this.transaction(() => {
      this.run(
        "INSERT OR IGNORE INTO audit (id, ts, session_id, json) VALUES (?, ?, ?, ?)",
        entry.id,
        entry.timestamp,
        typeof entry.sessionId === "string" ? entry.sessionId : null,
        JSON.stringify(entry),
      );
      if (++this.auditWrites % AUDIT_PRUNE_EVERY === 0) this.pruneAudit();
    });
  }

  pruneAudit(max = AUDIT_MAX_ROWS): void {
    this.run(
      "DELETE FROM audit WHERE seq <= (SELECT MAX(seq) FROM audit) - ?",
      max,
    );
  }

  /** Newest first. */
  recentAudit(limit: number, sessionId?: string): string[] {
    const rows = sessionId
      ? this.all<{ json: string }>(
          "SELECT json FROM audit WHERE session_id = ? ORDER BY seq DESC LIMIT ?",
          sessionId,
          limit,
        )
      : this.all<{ json: string }>(
          "SELECT json FROM audit ORDER BY seq DESC LIMIT ?",
          limit,
        );
    return rows.map((row) => row.json);
  }

  // --- legacy imports ------------------------------------------------------

  wasImported(name: string): boolean {
    return !!this.get("SELECT 1 AS x FROM legacy_imports WHERE name = ?", name);
  }

  markImported(name: string, rows: number): void {
    this.run(
      "INSERT OR REPLACE INTO legacy_imports (name, imported_at, rows) VALUES (?, ?, ?)",
      name,
      now(),
      rows,
    );
  }

  // --- backup / lifecycle ----------------------------------------------------

  /**
   * A consistent, self-contained copy (no -wal) via VACUUM INTO. The
   * destination must not exist. Safe while other connections write.
   */
  snapshotTo(destination: string): void {
    if (fs.existsSync(destination))
      throw new Error("Snapshot destination already exists");
    this.db.prepare("VACUUM INTO ?").run(destination);
    fs.chmodSync(destination, 0o600);
  }

  integrityOk(): boolean {
    return (
      this.get<{ integrity_check: string }>("PRAGMA integrity_check")
        ?.integrity_check === "ok"
    );
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    try {
      this.db.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    } catch {
      /* another connection holds the log; it checkpoints later */
    }
    this.db.close();
  }
}

// --- per-directory registry ---------------------------------------------------

const handles = new Map<string, NovaDb>();
const failed = new Map<string, string>();
let exitHook = false;

/** Called with a short message when the database cannot be used (default: stderr, once per directory). */
export let reportDbProblem = (message: string): void => {
  process.stderr.write(`[nova-db] ${message}\n`);
};
export function setDbProblemReporter(report: (message: string) => void): void {
  reportDbProblem = report;
}

/**
 * The shared connection for a data directory, or undefined when the database
 * cannot be opened (callers then fall back to their JSON file). A corrupt or
 * unreadable nova.db is left untouched on disk.
 */
export function novaDbFor(
  dir: string,
  options: { dirMode?: number } = {},
): NovaDb | undefined {
  const key = path.resolve(dir);
  const file = path.join(key, DB_FILE_NAME);
  const known = handles.get(key);
  if (known?.isOpen && fs.existsSync(file)) return known;
  if (known) {
    // The directory was removed or the handle closed behind our back.
    handles.delete(key);
    known.close();
  }
  if (failed.has(key)) return undefined;
  try {
    const opened = NovaDb.open(file, options);
    handles.set(key, opened);
    if (!exitHook) {
      exitHook = true;
      process.once("exit", closeAllNovaDbs);
    }
    return opened;
  } catch (error) {
    failed.set(key, String(error));
    reportDbProblem(
      `${file} unavailable, using JSON files: ${error instanceof Error ? error.message : String(error)}`,
    );
    return undefined;
  }
}

/** Checkpoints and closes every open connection; they reopen on demand. */
export function closeAllNovaDbs(): void {
  for (const [key, handle] of handles) {
    handles.delete(key);
    try {
      handle.close();
    } catch {
      /* closing is best effort */
    }
  }
  failed.clear();
}

/** Closes one directory's connection (e.g. before a restore). */
export function closeNovaDb(dir: string): void {
  const key = path.resolve(dir);
  const handle = handles.get(key);
  handles.delete(key);
  failed.delete(key);
  handle?.close();
}

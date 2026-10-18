import { afterEach, describe, expect, it } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { DatabaseSync } from "node:sqlite";
import { AuditService } from "../../../src/core/audit/audit.service.js";
import {
  deleteJsonState,
  readJsonState,
  writeJsonState,
} from "../../../src/core/db/json-state.js";
import {
  AUDIT_MAX_ROWS,
  closeAllNovaDbs,
  MIGRATIONS,
  NovaDb,
  novaDbFor,
  setDbProblemReporter,
} from "../../../src/core/db/nova-db.js";
import {
  restoreDatabase,
  snapshotDatabase,
} from "../../../src/core/db/snapshot.js";
import { DataBackupService } from "../../../src/dashboard/data-backup.service.js";
import { HistoryFile } from "../../../src/settings/history-file.js";
import type { NovaConfig } from "../../../src/core/config/nova-config.js";

type Row = { id: string; at: string; note: string };
const roots: string[] = [];
const problems: string[] = [];
setDbProblemReporter((message) => problems.push(message));
afterEach(() => {
  closeAllNovaDbs();
  problems.length = 0;
  for (const root of roots.splice(0))
    fs.rmSync(root, { recursive: true, force: true });
});
const tmp = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-db-"));
  roots.push(dir);
  return dir;
};
const id = (n: number) =>
  `00000000-0000-4000-8000-${n.toString(16).padStart(12, "0")}`;
const row = (n: number): Row => ({
  id: id(n),
  at: new Date(Date.UTC(2026, 0, 1, 0, 0, n)).toISOString(),
  note: `note ${n}`,
});
const history = (file: string, max?: number) =>
  new HistoryFile<Row>(
    file,
    (raw) => (typeof raw.note === "string" ? { note: raw.note } : undefined),
    max ? { max } : {},
  );

describe("nova.db core", () => {
  it("creates a 0600 WAL database and records numbered migrations once", () => {
    const dir = tmp();
    const db = novaDbFor(dir)!;
    expect(fs.statSync(path.join(dir, "nova.db")).mode & 0o777).toBe(0o600);
    expect(db.get<{ journal_mode: string }>("PRAGMA journal_mode")).toEqual(
      expect.objectContaining({ journal_mode: "wal" }),
    );
    expect(db.schemaVersion()).toBe(MIGRATIONS.at(-1)!.version);
    closeAllNovaDbs();
    const again = novaDbFor(dir)!;
    expect(
      again.all<{ version: number }>("SELECT version FROM schema_migrations"),
    ).toHaveLength(MIGRATIONS.length);
  });

  it("applies only the migrations that are still missing", () => {
    const dir = tmp();
    const file = path.join(dir, "nova.db");
    NovaDb.open(file).close();
    const extra = {
      version: 2,
      name: "test table",
      sql: "CREATE TABLE extra (x INTEGER)",
    };
    const db = NovaDb.open(file, { migrations: [...MIGRATIONS, extra] });
    expect(db.schemaVersion()).toBe(2);
    db.close();
    expect(() =>
      NovaDb.open(file, { migrations: [...MIGRATIONS, extra] }).close(),
    ).not.toThrow();
  });

  it("stores kv documents, revisions and audit rows", () => {
    const db = novaDbFor(tmp())!;
    db.kvSet("ns", "a", { n: 1 });
    expect(db.kvGet("ns", "a")).toEqual({ n: 1 });
    expect(db.kvAdd("ns", "a", { n: 2 })).toBe(false);
    expect(db.kvGet("ns", "a")).toEqual({ n: 1 });
    db.kvDelete("ns", "a");
    expect(db.kvGet("ns", "a")).toBeUndefined();
    db.appendAudit({ id: "1", timestamp: "t", sessionId: "s" });
    db.appendAudit({ id: "2", timestamp: "t" });
    expect(db.recentAudit(10)).toHaveLength(2);
    expect(db.recentAudit(10, "s")).toHaveLength(1);
  });

  it("rolls a failed transaction back completely", () => {
    const db = novaDbFor(tmp())!;
    expect(() =>
      db.transaction(() => {
        db.kvSet("ns", "a", 1);
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(db.kvGet("ns", "a")).toBeUndefined();
  });
});

describe("history revisions in nova.db", () => {
  it("keeps at most 100 revisions and returns them in order", () => {
    const dir = tmp();
    const log = history(path.join(dir, "demo-history.json"));
    for (let n = 1; n <= 130; n++) log.append(row(n));
    const all = log.all();
    expect(all).toHaveLength(100);
    expect(all[0]!.id).toBe(id(31));
    expect(all.at(-1)!.id).toBe(id(130));
    const stored = novaDbFor(dir)!.revisions("demo-history.json");
    expect(stored).toHaveLength(100);
  });

  it("supports removal and rewrite (what a rollback does) without touching other stores", () => {
    const dir = tmp();
    const a = history(path.join(dir, "a-history.json"));
    const b = history(path.join(dir, "b-history.json"));
    for (let n = 1; n <= 5; n++) {
      a.append(row(n));
      b.append(row(n));
    }
    a.write(a.all().filter((entry) => entry.id !== id(3)));
    expect(a.all().map((entry) => entry.id)).toEqual([
      id(1),
      id(2),
      id(4),
      id(5),
    ]);
    expect(b.all()).toHaveLength(5);
    expect(a.find(id(4))?.note).toBe("note 4");
    expect(a.list().revisions[0]!.id).toBe(id(5));
  });

  it("imports a legacy JSON history once, renames it and keeps later changes", () => {
    const dir = tmp();
    const file = path.join(dir, "demo-history.json");
    fs.writeFileSync(file, JSON.stringify([row(1), row(2), row(3)]));
    const log = history(file);
    expect(log.all().map((entry) => entry.id)).toEqual([id(1), id(2), id(3)]);
    expect(fs.existsSync(file)).toBe(false);
    expect(fs.existsSync(`${file}.migrated`)).toBe(true);
    log.write(log.all().filter((entry) => entry.id !== id(2)));
    // The old file reappears (e.g. an old backup extracted): it is not imported twice.
    fs.writeFileSync(file, JSON.stringify([row(1), row(2), row(3), row(9)]));
    expect(
      history(file)
        .all()
        .map((entry) => entry.id),
    ).toEqual([id(1), id(3)]);
    expect(fs.existsSync(file)).toBe(false);
    expect(
      novaDbFor(dir)!.get(
        "SELECT 1 AS x FROM legacy_imports WHERE name = ?",
        "revisions:demo-history.json",
      ),
    ).toBeTruthy();
  });

  it("caps an oversized legacy file at 100 rows on import", () => {
    const dir = tmp();
    const file = path.join(dir, "demo-history.json");
    fs.writeFileSync(
      file,
      JSON.stringify(Array.from({ length: 250 }, (_, n) => row(n + 1))),
    );
    const all = history(file).all();
    expect(all).toHaveLength(100);
    expect(all.at(-1)!.id).toBe(id(250));
  });

  it("quarantines a corrupt legacy file as .corrupt without crashing", () => {
    const dir = tmp();
    const file = path.join(dir, "demo-history.json");
    fs.writeFileSync(file, "{not json");
    const log = history(file);
    expect(log.all()).toEqual([]);
    expect(fs.readFileSync(`${file}.corrupt`, "utf8")).toBe("{not json");
    expect(problems.join()).toContain("set aside as .corrupt");
    log.append(row(1));
    expect(log.all()).toHaveLength(1);
  });

  it("falls back to the JSON file when nova.db cannot be opened", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "nova.db"));
    const file = path.join(dir, "demo-history.json");
    const log = history(file);
    log.append(row(1));
    log.append(row(2));
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toHaveLength(2);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(log.all().map((entry) => entry.id)).toEqual([id(1), id(2)]);
    expect(problems.join()).toContain("using JSON files");
  });
});

describe("small JSON state documents", () => {
  it("imports a legacy file once and then lives in kv", () => {
    const dir = tmp();
    const file = path.join(dir, "thing-progress.json");
    fs.writeFileSync(file, JSON.stringify({ completedDay: "2026-10-13" }));
    expect(readJsonState(file)).toEqual({ completedDay: "2026-10-13" });
    expect(fs.existsSync(`${file}.migrated`)).toBe(true);
    writeJsonState(file, { completedDay: "2026-10-14" });
    expect(readJsonState(file)).toEqual({ completedDay: "2026-10-14" });
    deleteJsonState(file);
    expect(readJsonState(file)).toBeUndefined();
  });

  it("a stale legacy file cannot overwrite newer state", () => {
    const dir = tmp();
    const file = path.join(dir, "thing-progress.json");
    fs.writeFileSync(file, JSON.stringify({ v: 1 }));
    writeJsonState(file, { v: 2 });
    expect(readJsonState(file)).toEqual({ v: 2 });
  });

  it("quarantines corrupt JSON and treats the state as absent", () => {
    const dir = tmp();
    const file = path.join(dir, "thing-progress.json");
    fs.writeFileSync(file, "{broken");
    expect(readJsonState(file)).toBeUndefined();
    expect(fs.existsSync(`${file}.corrupt`)).toBe(true);
  });

  it("uses the JSON file itself when the database is unavailable", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "nova.db"));
    const file = path.join(dir, "thing-progress.json");
    expect(readJsonState(file)).toBeUndefined();
    writeJsonState(file, { a: 1 });
    expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ a: 1 });
    expect(readJsonState(file)).toEqual({ a: 1 });
  });
});

describe("audit log in nova.db", () => {
  const service = (dir: string) =>
    new AuditService({
      dataFile: (name: string) => path.join(dir, name),
    } as never);

  it("imports actions.jsonl once, skipping damaged lines, and keeps newest-first reads", () => {
    const dir = tmp();
    const lines = [1, 2, 3].map((n) =>
      JSON.stringify({
        id: `id-${n}`,
        timestamp: `2026-01-0${n}T00:00:00.000Z`,
        sessionId: n === 2 ? "other" : "mine",
        tool: `t${n}`,
      }),
    );
    fs.writeFileSync(
      path.join(dir, "actions.jsonl"),
      `${lines[0]}\nnot json\n${lines[1]}\n${lines[2]}\n{"torn":`,
    );
    const audit = service(dir);
    expect(audit.read().map((entry) => entry.id)).toEqual([
      "id-3",
      "id-2",
      "id-1",
    ]);
    expect(audit.read(10, "mine").map((entry) => entry.id)).toEqual([
      "id-3",
      "id-1",
    ]);
    expect(fs.existsSync(path.join(dir, "actions.jsonl.migrated"))).toBe(true);
    audit.record({ tool: "new" });
    expect(audit.read(1)[0]!.tool).toBe("new");
    expect(service(dir).read(500)).toHaveLength(4);
  });

  it("preserves multibyte characters crossing the audit import chunk boundary", () => {
    const dir = tmp();
    const prefix =
      '{"id":"unicode","timestamp":"2026-01-01T00:00:00.000Z","note":"';
    const padding = "a".repeat((1 << 20) - Buffer.byteLength(prefix) - 1);
    const suffix = "€日🙂";
    fs.writeFileSync(
      path.join(dir, "actions.jsonl"),
      `${prefix}${padding}${suffix}"}\n`,
    );
    const entry = service(dir).read()[0];
    expect(typeof entry?.note).toBe("string");
    expect((entry?.note as string).endsWith(suffix)).toBe(true);
    expect((entry?.note as string).length).toBe(padding.length + suffix.length);
  });

  it("quarantines a log without any valid line", () => {
    const dir = tmp();
    fs.writeFileSync(
      path.join(dir, "actions.jsonl"),
      "garbage\nmore garbage\n",
    );
    expect(service(dir).read()).toEqual([]);
    expect(fs.existsSync(path.join(dir, "actions.jsonl.corrupt"))).toBe(true);
  });

  it("prunes to the newest rows", () => {
    const db = novaDbFor(tmp())!;
    for (let n = 1; n <= 12; n++)
      db.appendAudit({ id: `a${n}`, timestamp: `t${n}` });
    db.pruneAudit(5);
    expect(db.recentAudit(100)).toHaveLength(5);
    expect(AUDIT_MAX_ROWS).toBeGreaterThan(1000);
  });

  it("falls back to appending JSON lines when the database is unavailable", () => {
    const dir = tmp();
    fs.mkdirSync(path.join(dir, "nova.db"));
    const audit = service(dir);
    audit.record({ tool: "x", sessionId: "s" });
    expect(fs.readFileSync(path.join(dir, "actions.jsonl"), "utf8")).toContain(
      '"tool":"x"',
    );
    expect(audit.read(5, "s")).toHaveLength(1);
  });
});

describe("concurrent writers", () => {
  it("serialises two connections writing the same tables without losing rows", () => {
    const dir = tmp();
    const file = path.join(dir, "nova.db");
    const a = NovaDb.open(file);
    const b = NovaDb.open(file);
    for (let n = 0; n < 200; n++) {
      (n % 2 ? a : b).appendRevision(
        "shared",
        { id: `x${n}`, at: "t", json: "{}" },
        1000,
      );
      (n % 2 ? b : a).kvSet("counter", `k${n}`, n);
    }
    expect(a.revisions("shared")).toHaveLength(200);
    expect(b.kvKeys("counter")).toHaveLength(200);
    a.close();
    b.close();
  });

  it("waits for a writer in another process instead of failing with SQLITE_BUSY", async () => {
    const dir = tmp();
    const file = path.join(dir, "nova.db");
    NovaDb.open(file).close();
    const script = `
      const { DatabaseSync } = require("node:sqlite");
      const db = new DatabaseSync(process.argv[1]);
      db.exec("PRAGMA busy_timeout = 5000");
      db.exec("BEGIN IMMEDIATE");
      db.prepare("INSERT INTO kv (ns,key,json,updated_at) VALUES ('p','child','1','t')").run();
      process.stdout.write("locked\\n");
      setTimeout(() => { db.exec("COMMIT"); db.close(); }, 600);
    `;
    const child = spawn(process.execPath, ["-e", script, file], {
      stdio: ["ignore", "pipe", "ignore"],
    });
    await new Promise<void>((resolve) =>
      child.stdout.once("data", () => resolve()),
    );
    const db = NovaDb.open(file);
    const started = Date.now();
    db.kvSet("p", "parent", 2);
    expect(Date.now() - started).toBeGreaterThan(300);
    await new Promise((resolve) => child.once("close", resolve));
    expect(db.kvKeys("p")).toEqual(["child", "parent"]);
    db.close();
  });
});

describe("backup and restore", () => {
  it("snapshots with VACUUM INTO into a self-contained, valid file", () => {
    const dir = tmp();
    const db = novaDbFor(dir)!;
    db.kvSet("ns", "k", { live: true });
    const copy = path.join(tmp(), "copy.db");
    expect(snapshotDatabase(dir, copy)).toBe(true);
    expect(fs.existsSync(`${copy}-wal`)).toBe(false);
    const probe = new DatabaseSync(copy, { readOnly: true });
    expect(probe.prepare("SELECT json FROM kv WHERE ns='ns'").get()).toEqual(
      expect.objectContaining({ json: '{"live":true}' }),
    );
    probe.close();
    expect(snapshotDatabase(tmp(), path.join(tmp(), "none.db"))).toBe(false);
  });

  it("restores a snapshot over a live database and drops stale WAL files", () => {
    const dir = tmp();
    const db = novaDbFor(dir)!;
    db.kvSet("ns", "k", "before");
    const copy = path.join(tmp(), "copy.db");
    snapshotDatabase(dir, copy);
    db.kvSet("ns", "k", "after");
    db.kvSet("ns", "extra", 1);
    restoreDatabase(copy, dir);
    expect(fs.existsSync(path.join(dir, "nova.db.before-restore"))).toBe(true);
    const restored = novaDbFor(dir)!;
    expect(restored.kvGet("ns", "k")).toBe("before");
    expect(restored.kvGet("ns", "extra")).toBeUndefined();
    expect(fs.statSync(path.join(dir, "nova.db")).mode & 0o777).toBe(0o600);
  });

  it("removes stale rollback journals before reopening a restored database", () => {
    const dir = tmp();
    novaDbFor(dir)!.kvSet("ns", "k", "before");
    const copy = path.join(tmp(), "copy.db");
    snapshotDatabase(dir, copy);
    fs.writeFileSync(path.join(dir, "nova.db-journal"), "stale journal");
    restoreDatabase(copy, dir);
    expect(fs.existsSync(path.join(dir, "nova.db-journal"))).toBe(false);
    expect(novaDbFor(dir)!.kvGet("ns", "k")).toBe("before");
  });

  it("refuses to restore a damaged snapshot and leaves the live file alone", () => {
    const dir = tmp();
    novaDbFor(dir)!.kvSet("ns", "k", "keep");
    const bad = path.join(tmp(), "bad.db");
    fs.writeFileSync(bad, "this is not a database at all".repeat(50));
    expect(() => restoreDatabase(bad, dir)).toThrow();
    expect(novaDbFor(dir)!.kvGet("ns", "k")).toBe("keep");
  });

  it("scheduled archives contain a VACUUM INTO snapshot, never the live WAL files, and restore round-trips", async () => {
    const root = tmp();
    const dataDir = path.join(root, "data");
    const backupDir = path.join(root, "backups");
    fs.mkdirSync(dataDir);
    fs.writeFileSync(path.join(dataDir, "settings.json"), "{}\n");
    const db = novaDbFor(dataDir)!;
    db.kvSet("ns", "k", { v: 1 });
    for (let n = 1; n <= 5; n++)
      history(path.join(dataDir, "h-history.json")).append(row(n));
    expect(fs.existsSync(path.join(dataDir, "nova.db-wal"))).toBe(true);
    const service = new DataBackupService(
      { dataDir, backupDir, timezone: "Europe/Amsterdam" } as NovaConfig,
      { record: () => undefined } as never,
    );
    await service.checkSchedule(new Date("2026-10-12T01:40:00.000Z"));
    const archive = path.join(backupDir, "daily-2026-10-12.tar.gz");
    const listing = spawnSync(
      "tar",
      ["--list", "--gzip", `--file=${archive}`],
      {
        encoding: "utf8",
      },
    );
    const names = listing.stdout.split("\n").filter(Boolean);
    expect(names).toContain("./nova.db");
    expect(names.filter((name) => name.includes("nova.db"))).toEqual([
      "./nova.db",
    ]);
    expect(fs.readdirSync(backupDir).filter((n) => n.startsWith("."))).toEqual(
      [],
    );
    // Restore into a fresh data dir and read everything back.
    const restoreDir = path.join(root, "restored");
    fs.mkdirSync(restoreDir);
    expect(
      spawnSync("tar", ["--extract", "--gzip", `--file=${archive}`], {
        cwd: restoreDir,
      }).status,
    ).toBe(0);
    closeAllNovaDbs();
    const restored = novaDbFor(restoreDir)!;
    expect(restored.integrityOk()).toBe(true);
    expect(restored.kvGet("ns", "k")).toEqual({ v: 1 });
    expect(restored.revisions("h-history.json")).toHaveLength(5);
    // The live data directory still has its own database; only a snapshot was archived.
    expect(fs.existsSync(path.join(dataDir, "nova.db"))).toBe(true);
  });
});

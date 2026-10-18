import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { importLegacyLines } from "../db/legacy-import.js";
import { novaDbFor, type NovaDb } from "../db/nova-db.js";
import { NovaConfig } from "../config/nova-config.js";
import { sanitize } from "../security/sanitize.js";

export interface AuditRecord {
  sessionId?: string;
  tool?: string;
  risk?: string;
  confirmation?: string;
  arguments?: unknown;
  result?: unknown;
  verification?: unknown;
  durationMs?: number;
  phase?: string;
  [key: string]: unknown;
}

export type AuditEntry = AuditRecord & { id: string; timestamp: string };

/**
 * The action log, kept in nova.db (table `audit`, newest 200 000 rows) and
 * readable only by NOVA. Everything is sanitized before it is written. An old
 * `actions.jsonl` is imported once and renamed `*.migrated`; when the database
 * is unavailable the log falls back to appending that JSON-lines file.
 */
@Injectable()
export class AuditService {
  private readonly file: string;

  constructor(config: NovaConfig) {
    this.file = config.dataFile("actions.jsonl");
  }

  private db(): NovaDb | undefined {
    const db = novaDbFor(path.dirname(this.file));
    if (!db) return undefined;
    importLegacyLines(db, "audit:actions.jsonl", this.file, (value) => {
      const entry = value as Partial<AuditEntry> | null;
      if (
        !entry ||
        typeof entry !== "object" ||
        typeof entry.id !== "string" ||
        typeof entry.timestamp !== "string"
      )
        return false;
      db.appendAudit(entry as AuditEntry);
      return true;
    });
    return db;
  }

  record(record: AuditRecord): AuditEntry {
    const entry = sanitize({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...record,
    });
    const db = this.db();
    if (db) db.appendAudit(entry);
    else
      fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, {
        mode: 0o600,
      });
    return entry;
  }

  /** The newest entries first; optionally for one session. */
  read(limit = 100, sessionId?: string): AuditEntry[] {
    const count = Math.min(500, Math.max(1, limit));
    const db = this.db();
    if (db)
      return db.recentAudit(count, sessionId).flatMap((json) => {
        try {
          return [JSON.parse(json) as AuditEntry];
        } catch {
          return [];
        }
      });
    return this.readFile(count, sessionId);
  }

  /** JSON-lines fallback: the last 2 MB of the file. */
  private readFile(count: number, sessionId?: string): AuditEntry[] {
    if (!fs.existsSync(this.file)) return [];
    const fd = fs.openSync(this.file, "r");
    try {
      const size = fs.fstatSync(fd).size;
      const start = Math.max(0, size - 2_000_000);
      const bytes = Buffer.alloc(size - start);
      fs.readSync(fd, bytes, 0, bytes.length, start);
      const lines = bytes.toString().split("\n");
      if (start) lines.shift();
      return lines
        .filter(Boolean)
        .flatMap((line) => {
          try {
            return [JSON.parse(line) as AuditEntry];
          } catch {
            return [];
          }
        })
        .filter((entry) => !sessionId || entry.sessionId === sessionId)
        .slice(-count)
        .reverse();
    } finally {
      fs.closeSync(fd);
    }
  }
}

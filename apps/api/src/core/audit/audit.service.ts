import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
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
 * The action log: one JSON line per action, append-only, readable only by NOVA.
 * Everything is sanitized before it is written.
 */
@Injectable()
export class AuditService {
  private readonly file: string;

  constructor(config: NovaConfig) {
    this.file = config.dataFile("actions.jsonl");
  }

  record(record: AuditRecord): AuditEntry {
    const entry = sanitize({
      id: crypto.randomUUID(),
      timestamp: new Date().toISOString(),
      ...record,
    });
    fs.appendFileSync(this.file, `${JSON.stringify(entry)}\n`, { mode: 0o600 });
    return entry;
  }

  /** The newest entries first, from the last 2 MB of the log; optionally for one session. */
  read(limit = 100, sessionId?: string): AuditEntry[] {
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
        .slice(-Math.min(500, Math.max(1, limit)))
        .reverse();
    } finally {
      fs.closeSync(fd);
    }
  }
}

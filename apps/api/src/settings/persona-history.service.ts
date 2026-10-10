import { Injectable, NotFoundException } from "@nestjs/common";
import { isDeepStrictEqual } from "node:util";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { PersonaHistory, PersonaRevision } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { SettingsStore } from "./store/settings.store.js";

const MAX_PERSONA_LENGTH = 2000;
const normalize = (value: unknown): string =>
  typeof value === "string" && value.length <= MAX_PERSONA_LENGTH
    ? sanitize(value)
    : "";

/** Private, bounded snapshots of user-authored behavior rules. */
@Injectable()
export class PersonaHistoryService {
  lastWarning: string | undefined;
  private readonly file: string;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("persona-history.json");
  }

  private read(): PersonaRevision[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) return [];
      return value.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return [];
        const row = entry as Record<string, unknown>;
        if (
          typeof row.id !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(row.id) ||
          typeof row.at !== "string" ||
          !Number.isFinite(Date.parse(row.at)) ||
          typeof row.before !== "string" ||
          row.before.length > MAX_PERSONA_LENGTH ||
          typeof row.after !== "string" ||
          row.after.length > MAX_PERSONA_LENGTH
        )
          return [];
        return [
          {
            id: row.id,
            at: new Date(row.at).toISOString(),
            before: row.before,
            after: row.after,
            ...(typeof row.revertedFrom === "string"
              ? { revertedFrom: row.revertedFrom }
              : {}),
          },
        ];
      });
    } catch {
      return [];
    }
  }

  private write(entries: PersonaRevision[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    let fd: number | undefined;
    try {
      fs.writeFileSync(temporary, JSON.stringify(entries.slice(-100)), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      fd = fs.openSync(temporary, "r");
      fs.fsyncSync(fd);
      fs.closeSync(fd);
      fd = undefined;
      fs.renameSync(temporary, this.file);
      const directory = fs.openSync(path.dirname(this.file), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      if (fd !== undefined) fs.closeSync(fd);
      fs.rmSync(temporary, { force: true });
    }
  }

  list(): PersonaHistory {
    const all = this.read();
    return { revisions: all.slice(-50).reverse(), truncated: all.length > 50 };
  }

  record(beforeValue: string, afterValue: string, revertedFrom?: string): void {
    this.lastWarning = undefined;
    const before = normalize(beforeValue);
    const after = normalize(afterValue);
    if (isDeepStrictEqual(before, after)) return;
    const revision: PersonaRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before,
      after,
      ...(revertedFrom ? { revertedFrom } : {}),
    };
    try {
      this.write([...this.read(), revision]);
    } catch {
      this.lastWarning =
        "Eigen regels opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
      return;
    }
  }

  rollback(id: string): {
    ok: true;
    persona: string;
    auditWarning?: string;
  } {
    const revision = this.read().find((entry) => entry.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = normalize(this.settings.get().persona);
    if (!isDeepStrictEqual(current, revision.after))
      throw new NotFoundException(
        "De eigen regels zijn daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: { what: "persona_rollback", revision: id },
      phase: "attempt",
    });
    this.settings.update((next) => {
      if (!isDeepStrictEqual(normalize(next.persona), revision.after))
        throw new NotFoundException(
          "De eigen regels zijn intussen gewijzigd. Terugdraaien is afgebroken.",
        );
      next.persona = revision.before;
    });
    this.record(current, revision.before, id);
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: { what: "persona_rollback", revision: id },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Eigen regels zijn teruggedraaid, maar de auditmelding kon niet worden geschreven.";
    }
    return {
      ok: true,
      persona: revision.before,
      ...(this.lastWarning ? { auditWarning: this.lastWarning } : {}),
    };
  }
}

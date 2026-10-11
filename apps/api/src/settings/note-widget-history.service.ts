import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { NoteWidget } from "@nova/contracts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import { SettingsStore } from "./store/settings.store.js";

type Revision = {
  id: string;
  at: string;
  widgetId: string;
  before: string;
  after: string;
  revertedFrom?: string;
};
const safeText = (value: unknown): string | null =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.length <= 1000 &&
  !/\b[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i.test(value) &&
  sanitize(value) === value
    ? value
    : null;

/** Private, bounded history for existing note text only. */
@Injectable()
export class NoteWidgetHistory {
  lastWarning: string | undefined;
  private readonly file: string;
  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("note-widget-history.json");
  }

  private read(): Revision[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) return [];
      return value
        .flatMap((raw: unknown) => {
          if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
          const row = raw as Record<string, unknown>;
          const before = safeText(row.before);
          const after = safeText(row.after);
          if (
            typeof row.id !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(row.id) ||
            typeof row.at !== "string" ||
            !Number.isFinite(Date.parse(row.at)) ||
            typeof row.widgetId !== "string" ||
            !/^[a-z0-9_-]{1,80}$/.test(row.widgetId) ||
            before === null ||
            after === null
          )
            return [];
          return [
            {
              id: row.id,
              at: new Date(row.at).toISOString(),
              widgetId: row.widgetId,
              before,
              after,
              ...(typeof row.revertedFrom === "string"
                ? { revertedFrom: row.revertedFrom }
                : {}),
            },
          ];
        })
        .slice(-100);
    } catch {
      return [];
    }
  }

  private write(rows: Revision[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temp = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, JSON.stringify(rows.slice(-100)), { mode: 0o600 });
      fs.chmodSync(temp, 0o600);
      const fd = fs.openSync(temp, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temp, this.file);
      const directory = fs.openSync(path.dirname(this.file), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  list(widgetId: string) {
    const rows = this.read().filter((row) => row.widgetId === widgetId);
    return {
      revisions: rows.slice(-50).reverse(),
      truncated: rows.length > 50,
    };
  }

  forget(widgetId: string): void {
    const rows = this.read();
    const remaining = rows.filter((row) => row.widgetId !== widgetId);
    if (remaining.length !== rows.length) this.write(remaining);
  }

  record(widgetId: string, beforeValue: unknown, afterValue: unknown): void {
    this.lastWarning = undefined;
    const before = safeText(beforeValue);
    const after = safeText(afterValue);
    if (before === null || after === null) {
      this.lastWarning =
        "De notitie is opgeslagen, maar tekst die op een geheim lijkt is niet in de geschiedenis gezet.";
      return;
    }
    if (before === after) return;
    const revision: Revision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      widgetId,
      before,
      after,
    };
    try {
      this.write([...this.read(), revision]);
    } catch {
      this.lastWarning =
        "De notitie is opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
      return;
    }
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "SAFE",
        confirmation: "admin_ui",
        arguments: {
          what: "note_widget_text",
          widgetId,
          revision: revision.id,
        },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Notitiegeschiedenis opgeslagen, maar de auditmelding kon niet worden geschreven.";
    }
  }

  rollback(
    widgetId: string,
    id: string,
  ): {
    ok: true;
    widget: NoteWidget;
    historyWarning?: string;
  } {
    this.lastWarning = undefined;
    const revision = this.read().find(
      (row) => row.widgetId === widgetId && row.id === id,
    );
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const widget = this.settings
      .get()
      .widgets.find((item) => item.id === widgetId);
    if (!widget || widget.type !== "note")
      throw new ConflictException(
        "De notitie bestaat niet meer. Terugdraaien is afgebroken.",
      );
    if (!isDeepStrictEqual(widget.text, revision.after))
      throw new ConflictException(
        "De notitie is daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: { what: "note_widget_rollback", widgetId, revision: id },
      phase: "attempt",
    });
    let restored!: NoteWidget;
    this.settings.update((settings) => {
      const index = settings.widgets.findIndex((item) => item.id === widgetId);
      const current = settings.widgets[index] as NoteWidget | undefined;
      if (
        !current ||
        current.type !== "note" ||
        current.text !== revision.after
      )
        throw new ConflictException(
          "De notitie is daarna gewijzigd. Terugdraaien is afgebroken.",
        );
      restored = { ...current, text: revision.before };
      settings.widgets[index] = restored as unknown as Record<string, unknown>;
    });
    const inverse: Revision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      widgetId,
      before: revision.after,
      after: revision.before,
      revertedFrom: id,
    };
    try {
      this.write([...this.read(), inverse]);
    } catch {
      this.lastWarning =
        "De notitie is hersteld, maar de geschiedenis kon niet worden bijgewerkt.";
    }
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: { what: "note_widget_rollback", widgetId, revision: id },
        result: { ok: true, warning: this.lastWarning },
      });
    } catch {
      this.lastWarning =
        "De notitie is hersteld, maar de auditmelding kon niet worden geschreven.";
    }
    return {
      ok: true,
      widget: restored,
      ...(this.lastWarning ? { historyWarning: this.lastWarning } : {}),
    };
  }
}

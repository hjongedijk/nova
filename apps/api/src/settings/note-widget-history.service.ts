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
  beforeSnapshot?: { title: string; enabled: boolean; text: string };
  afterSnapshot?: { title: string; enabled: boolean; text: string };
  createdSnapshot?: { title: string; enabled: boolean; text: string };
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

function safeSnapshot(value: unknown): Revision["beforeSnapshot"] {
  if (!value || typeof value !== "object" || Array.isArray(value))
    return undefined;
  const row = value as Record<string, unknown>;
  const title = safeText(row.title);
  const text = safeText(row.text);
  if (
    Object.keys(row).some(
      (key) => !["title", "enabled", "text"].includes(key),
    ) ||
    title === null ||
    title.length > 40 ||
    text === null ||
    typeof row.enabled !== "boolean"
  )
    return undefined;
  return { title, enabled: row.enabled, text };
}

const snapshot = (widget: NoteWidget) => ({
  title: widget.title,
  enabled: widget.enabled,
  text: widget.text,
});

/** Private, bounded history for sanitized note content and metadata only. */
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
          const createdSnapshot =
            row.createdSnapshot &&
            typeof row.createdSnapshot === "object" &&
            !Array.isArray(row.createdSnapshot)
              ? (row.createdSnapshot as Record<string, unknown>)
              : undefined;
          const beforeSnapshot = safeSnapshot(row.beforeSnapshot);
          const afterSnapshot = safeSnapshot(row.afterSnapshot);
          const createdTitle = safeText(createdSnapshot?.title);
          const createdText = safeText(createdSnapshot?.text);
          const isCreated =
            createdTitle !== null &&
            createdText !== null &&
            createdText === after &&
            typeof createdSnapshot?.enabled === "boolean";
          const isSnapshotRevision =
            beforeSnapshot !== undefined &&
            afterSnapshot !== undefined &&
            beforeSnapshot.text === before &&
            afterSnapshot.text === after;
          if (
            typeof row.id !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(row.id) ||
            typeof row.at !== "string" ||
            !Number.isFinite(Date.parse(row.at)) ||
            typeof row.widgetId !== "string" ||
            !/^[a-z0-9_-]{1,80}$/.test(row.widgetId) ||
            (before === null && !isCreated) ||
            ((row.beforeSnapshot !== undefined ||
              row.afterSnapshot !== undefined) &&
              !isSnapshotRevision) ||
            after === null
          )
            return [];
          return [
            {
              id: row.id,
              at: new Date(row.at).toISOString(),
              widgetId: row.widgetId,
              before: before ?? "",
              after,
              ...(isSnapshotRevision ? { beforeSnapshot, afterSnapshot } : {}),
              ...(isCreated
                ? {
                    createdSnapshot: {
                      title: createdTitle,
                      enabled: createdSnapshot.enabled as boolean,
                      text: createdText,
                    },
                  }
                : {}),
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

  record(
    widgetId: string,
    beforeWidget: NoteWidget,
    afterWidget: NoteWidget,
  ): void {
    this.lastWarning = undefined;
    const beforeSnapshot = safeSnapshot(snapshot(beforeWidget));
    const afterSnapshot = safeSnapshot(snapshot(afterWidget));
    if (!beforeSnapshot || !afterSnapshot) {
      this.lastWarning =
        "De notitie is opgeslagen, maar tekst die op een geheim lijkt is niet in de geschiedenis gezet.";
      return;
    }
    if (isDeepStrictEqual(beforeSnapshot, afterSnapshot)) return;
    const revision: Revision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      widgetId,
      before: beforeSnapshot.text,
      after: afterSnapshot.text,
      beforeSnapshot,
      afterSnapshot,
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
          what: "note_widget_update",
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

  recordCreated(widget: NoteWidget): void {
    this.lastWarning = undefined;
    const title = safeText(widget.title);
    const text = safeText(widget.text);
    if (title === null || text === null) {
      this.lastWarning =
        "De notitie is opgeslagen, maar tekst die op een geheim lijkt is niet in de geschiedenis gezet.";
      return;
    }
    const revision: Revision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      widgetId: widget.id,
      before: "",
      after: text,
      createdSnapshot: { title, enabled: widget.enabled, text },
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
          what: "note_widget_created",
          widgetId: widget.id,
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
    widget?: NoteWidget;
    removed?: true;
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
      .widgets.find((item) => item.id === widgetId) as NoteWidget | undefined;
    if (!widget || widget.type !== "note")
      throw new ConflictException(
        "De notitie bestaat niet meer. Terugdraaien is afgebroken.",
      );
    if (revision.createdSnapshot) {
      const snapshot = revision.createdSnapshot;
      if (
        widget.title !== snapshot.title ||
        widget.enabled !== snapshot.enabled ||
        widget.text !== snapshot.text
      )
        throw new ConflictException(
          "De notitie is daarna gewijzigd. Terugdraaien is afgebroken.",
        );
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: {
          what: "note_widget_creation_rollback",
          widgetId,
          revision: id,
        },
        phase: "attempt",
      });
      this.settings.update((settings) => {
        const current = settings.widgets.find(
          (item) => item.id === widgetId,
        ) as NoteWidget | undefined;
        if (
          !current ||
          current.type !== "note" ||
          current.title !== snapshot.title ||
          current.enabled !== snapshot.enabled ||
          current.text !== snapshot.text
        )
          throw new ConflictException(
            "De notitie is daarna gewijzigd. Terugdraaien is afgebroken.",
          );
        settings.widgets = settings.widgets.filter(
          (item) => item.id !== widgetId,
        );
        if (settings.sidebar)
          settings.sidebar.items = settings.sidebar.items.filter(
            (item) => item.id !== `w:${widgetId}`,
          );
      });
      try {
        this.forget(widgetId);
      } catch {
        this.lastWarning =
          "De notitie is verwijderd, maar de wijzigingsgeschiedenis kon niet worden gewist.";
      }
      try {
        this.audit.record({
          sessionId: "settings",
          tool: "settings_change",
          risk: "CONFIRM",
          confirmation: "admin_ui",
          arguments: {
            what: "note_widget_creation_rollback",
            widgetId,
            revision: id,
          },
          result: { ok: true, warning: this.lastWarning },
        });
      } catch {
        this.lastWarning =
          "De notitie is verwijderd, maar de auditmelding kon niet worden geschreven.";
      }
      return {
        ok: true,
        removed: true,
        ...(this.lastWarning ? { historyWarning: this.lastWarning } : {}),
      };
    }
    const widgetSnapshot = snapshot(widget);
    const expectedAfter = revision.afterSnapshot ?? {
      ...widgetSnapshot,
      text: revision.after,
    };
    if (!isDeepStrictEqual(widgetSnapshot, expectedAfter))
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
        !isDeepStrictEqual(
          snapshot(current),
          revision.afterSnapshot ?? {
            ...snapshot(current),
            text: revision.after,
          },
        )
      )
        throw new ConflictException(
          "De notitie is daarna gewijzigd. Terugdraaien is afgebroken.",
        );
      restored = revision.beforeSnapshot
        ? { ...current, ...revision.beforeSnapshot }
        : { ...current, text: revision.before };
      settings.widgets[index] = restored as unknown as Record<string, unknown>;
    });
    const inverse: Revision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      widgetId,
      before: revision.after,
      after: revision.before,
      ...(revision.beforeSnapshot && revision.afterSnapshot
        ? {
            beforeSnapshot: revision.afterSnapshot,
            afterSnapshot: revision.beforeSnapshot,
          }
        : {}),
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

import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { ListWidget, ValueWidget, Widget } from "@nova/contracts";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, listRecent, revertedFromField } from "./history-file.js";
import { sanitize } from "../core/security/sanitize.js";
import { SettingsStore } from "./store/settings.store.js";

export type WidgetDisplay =
  | { type: "value"; title: string; unit: string }
  | { type: "list"; title: string; itemPath: string; max: number };
type Revision = {
  id: string;
  at: string;
  widgetId: string;
  before: WidgetDisplay;
  after: WidgetDisplay;
  revertedFrom?: string;
};

function safeText(
  value: unknown,
  max: number,
  allowEmpty = false,
): value is string {
  return (
    typeof value === "string" &&
    value.length <= max &&
    (allowEmpty || value.trim().length > 0) &&
    !/\b[a-z][a-z0-9+.-]*:\/\/[^/?#\s]*@/i.test(value) &&
    sanitize(value) === value
  );
}

function display(widget: Widget): WidgetDisplay | null {
  if (widget.type === "value" && safeText(widget.title, 40)) {
    return safeText(widget.unit, 12, true)
      ? { type: "value", title: widget.title, unit: widget.unit }
      : null;
  }
  if (widget.type === "list" && safeText(widget.title, 40)) {
    return safeText(widget.itemPath, 60, true) &&
      Number.isInteger(widget.max) &&
      widget.max >= 1 &&
      widget.max <= 10
      ? {
          type: "list",
          title: widget.title,
          itemPath: widget.itemPath,
          max: widget.max,
        }
      : null;
  }
  return null;
}

function validDisplay(value: unknown): value is WidgetDisplay {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const row = value as Record<string, unknown>;
  if (row.type === "value")
    return (
      Object.keys(row).every((key) =>
        ["type", "title", "unit"].includes(key),
      ) &&
      safeText(row.title, 40) &&
      safeText(row.unit, 12, true)
    );
  if (row.type === "list")
    return (
      Object.keys(row).every((key) =>
        ["type", "title", "itemPath", "max"].includes(key),
      ) &&
      safeText(row.title, 40) &&
      safeText(row.itemPath, 60, true) &&
      Number.isInteger(row.max) &&
      Number(row.max) >= 1 &&
      Number(row.max) <= 10
    );
  return false;
}

/** Private history for presentation-only widget fields; never stores data sources or actions. */
@Injectable()
export class WidgetDisplayHistory {
  lastWarning: string | undefined;
  private readonly history: HistoryFile<Revision>;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<Revision>(
      config.dataFile("widget-display-history.json"),
      (row) =>
        typeof row.widgetId === "string" &&
        /^[a-z0-9_-]{1,80}$/.test(row.widgetId) &&
        validDisplay(row.before) &&
        validDisplay(row.after) &&
        row.before.type === row.after.type
          ? {
              widgetId: row.widgetId,
              before: row.before,
              after: row.after,
              ...revertedFromField(row, false),
            }
          : undefined,
      { durability: "dir" },
    );
  }

  list(widgetId: string) {
    const rows = this.history.all().filter((row) => row.widgetId === widgetId);
    return listRecent(rows);
  }

  forget(widgetId: string): void {
    const rows = this.history.all();
    const remaining = rows.filter((row) => row.widgetId !== widgetId);
    if (remaining.length !== rows.length) this.history.write(remaining);
  }

  record(widgetId: string, beforeWidget: Widget, afterWidget: Widget): void {
    this.lastWarning = undefined;
    const before = display(beforeWidget);
    const after = display(afterWidget);
    if (!before || !after) {
      this.lastWarning =
        "Het paneel is opgeslagen, maar onveilige presentatiegegevens zijn niet in de geschiedenis gezet.";
      return;
    }
    if (before.type !== after.type || isDeepStrictEqual(before, after)) return;
    const revision: Revision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      widgetId,
      before,
      after,
    };
    try {
      this.history.append(revision);
    } catch {
      this.lastWarning =
        "Het paneel is opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
      return;
    }
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "SAFE",
        confirmation: "admin_ui",
        arguments: { what: "widget_display", widgetId, revision: revision.id },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Widgetgeschiedenis opgeslagen, maar de auditmelding kon niet worden geschreven.";
    }
  }

  rollback(widgetId: string, id: string) {
    this.lastWarning = undefined;
    const revision = this.history
      .all()
      .find((row) => row.widgetId === widgetId && row.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const widget = this.settings
      .get()
      .widgets.find((item) => item.id === widgetId) as Widget | undefined;
    const current = widget && display(widget);
    if (!current || current.type !== revision.after.type)
      throw new ConflictException(
        "Dit waarde- of lijstpaneel bestaat niet meer. Terugdraaien is afgebroken.",
      );
    if (!isDeepStrictEqual(current, revision.after))
      throw new ConflictException(
        "De paneelweergave is daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: { what: "widget_display_rollback", widgetId, revision: id },
      phase: "attempt",
    });
    let restored!: Widget;
    this.settings.update((settings) => {
      const index = settings.widgets.findIndex((item) => item.id === widgetId);
      const latest = settings.widgets[index] as Widget | undefined;
      const latestDisplay = latest && display(latest);
      if (
        !latest ||
        !latestDisplay ||
        !isDeepStrictEqual(latestDisplay, revision.after)
      )
        throw new ConflictException(
          "De paneelweergave is daarna gewijzigd. Terugdraaien is afgebroken.",
        );
      restored =
        revision.before.type === "value" && latest.type === "value"
          ? ({
              ...latest,
              title: revision.before.title,
              unit: revision.before.unit,
            } satisfies ValueWidget)
          : revision.before.type === "list" && latest.type === "list"
            ? ({
                ...latest,
                title: revision.before.title,
                itemPath: revision.before.itemPath,
                max: revision.before.max,
              } satisfies ListWidget)
            : latest;
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
      this.history.append(inverse);
    } catch {
      this.lastWarning =
        "De weergave is teruggezet, maar de geschiedenis kon niet worden bijgewerkt.";
    }
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: { what: "widget_display_rollback", widgetId, revision: id },
        result: { ok: true, warning: this.lastWarning },
      });
    } catch {
      this.lastWarning =
        "De weergave is teruggezet, maar de auditmelding kon niet worden geschreven.";
    }
    return {
      ok: true as const,
      widget: restored,
      historyWarning: this.lastWarning,
    };
  }
}

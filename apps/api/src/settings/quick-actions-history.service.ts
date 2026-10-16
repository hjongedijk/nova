import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  QuickAction,
  QuickActionHistory,
  QuickActionRevision,
  QuickActionSnapshot,
} from "@nova/contracts";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile } from "./history-file.js";
import { sanitize } from "../core/security/sanitize.js";
import { normalizeQuickActions } from "./settings-validation.js";
import { SettingsStore } from "./store/settings.store.js";

const clean = (value: unknown): QuickAction[] | null => {
  try {
    const items = normalizeQuickActions(value);
    if (
      !isDeepStrictEqual(sanitize(items), items) ||
      items.some((item) =>
        [item.label, item.prompt].some((text) =>
          /https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(text),
        ),
      )
    )
      return null;
    return items;
  } catch {
    return null;
  }
};
const cleanSnapshot = (value: unknown): QuickActionSnapshot | null => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const row = value as Record<string, unknown>;
  if (typeof row.isDefault !== "boolean") return null;
  const items = clean(row.items);
  return items ? { isDefault: row.isDefault, items } : null;
};

/** Bounded private history for saved home-screen button text; never executes actions. */
@Injectable()
export class QuickActionsHistory {
  lastWarning: string | undefined;
  private readonly history: HistoryFile<QuickActionRevision>;
  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<QuickActionRevision>(
      config.dataFile("quick-actions-history.json"),
      (row) => {
        const before = cleanSnapshot(row.before);
        const after = cleanSnapshot(row.after);
        return before && after ? { before, after } : undefined;
      },
      { durability: "file" },
    );
  }

  list(): QuickActionHistory {
    return this.history.list();
  }

  current(): QuickActionSnapshot {
    return {
      isDefault: this.settings.get().quickActions === null,
      items: this.settings.quickActions(),
    };
  }

  record(
    beforeValue: QuickActionSnapshot,
    afterValue: QuickActionSnapshot,
  ): void {
    this.lastWarning = undefined;
    const before = cleanSnapshot(beforeValue);
    const after = cleanSnapshot(afterValue);
    if (!before || !after) {
      this.lastWarning =
        "Snelle opdrachten zijn opgeslagen, maar tekst die op een geheim lijkt is niet in de geschiedenis gezet.";
      return;
    }
    if (isDeepStrictEqual(before, after)) return;
    const revision: QuickActionRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before,
      after,
    };
    try {
      this.history.append(revision);
    } catch {
      this.lastWarning =
        "Snelle opdrachten zijn opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
      return;
    }
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "SAFE",
        confirmation: "admin_ui",
        arguments: { what: "quick_actions", revision: revision.id },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "De geschiedenis is opgeslagen, maar de auditmelding kon niet worden geschreven.";
    }
  }

  rollback(id: string): {
    ok: true;
    quickActions: QuickAction[];
    auditWarning?: string;
  } {
    const revision = this.history.all().find((row) => row.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = cleanSnapshot(this.current());
    if (!current || !isDeepStrictEqual(current, revision.after))
      throw new ConflictException(
        "De snelle opdrachten zijn daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: { what: "quick_actions_rollback", revision: id },
      phase: "attempt",
    });
    this.settings.update((next) => {
      const latest = cleanSnapshot({
        isDefault: next.quickActions === null,
        items: next.quickActions ?? this.settings.quickActions(),
      });
      if (!latest || !isDeepStrictEqual(latest, revision.after))
        throw new ConflictException(
          "De snelle opdrachten zijn intussen gewijzigd. Terugdraaien is afgebroken.",
        );
      next.quickActions = revision.before.isDefault
        ? null
        : revision.before.items;
    });
    this.record(current, revision.before);
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: { what: "quick_actions_rollback", revision: id },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Snelle opdrachten zijn hersteld, maar de auditmelding kon niet worden geschreven.";
    }
    return {
      ok: true,
      quickActions: this.settings.quickActions(),
      ...(this.lastWarning ? { auditWarning: this.lastWarning } : {}),
    };
  }
}

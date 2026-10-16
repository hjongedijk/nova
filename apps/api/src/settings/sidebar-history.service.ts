import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { SidebarItem, SidebarRevision } from "@nova/contracts";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, revertedFromField } from "./history-file.js";
import { SettingsStore } from "./store/settings.store.js";
import { resolveSidebar } from "./settings-validation.js";

const clean = (value: unknown): SidebarItem[] => {
  if (!Array.isArray(value) || value.length > 100) return [];
  return value.flatMap((item: unknown) => {
    if (!item || typeof item !== "object" || Array.isArray(item)) return [];
    const row = item as Record<string, unknown>;
    if (
      typeof row.id !== "string" ||
      !/^[A-Za-z0-9:_-]{1,80}$/.test(row.id) ||
      !["left", "right"].includes(String(row.column)) ||
      !Number.isInteger(row.page) ||
      (row.page as number) < 1 ||
      (row.page as number) > 5 ||
      typeof row.shown !== "boolean"
    )
      return [];
    return [
      {
        id: row.id,
        column: row.column as "left" | "right",
        page: row.page as number,
        shown: row.shown,
      },
    ];
  });
};

/** Private, bounded history of the non-secret sidebar layout only. */
@Injectable()
export class SidebarHistory {
  lastWarning: string | undefined;
  private readonly history: HistoryFile<SidebarRevision>;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<SidebarRevision>(
      config.dataFile("sidebar-history.json"),
      (row) => {
        const before = clean(row.before);
        const after = clean(row.after);
        if (
          !Array.isArray(row.before) ||
          !Array.isArray(row.after) ||
          before.length !== row.before.length ||
          after.length !== row.after.length ||
          !before.length
        )
          return undefined;
        return { before, after, ...revertedFromField(row, false) };
      },
      {},
    );
  }

  list() {
    return this.history.list();
  }

  record(
    before: SidebarItem[],
    after: SidebarItem[],
    revertedFrom?: string,
  ): void {
    this.lastWarning = undefined;
    if (isDeepStrictEqual(before, after)) return;
    const revision: SidebarRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before: clean(before),
      after: clean(after),
      ...(revertedFrom ? { revertedFrom } : {}),
    };
    try {
      this.history.append(revision);
    } catch {
      this.lastWarning =
        "De indeling is opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
      return;
    }
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "SAFE",
        confirmation: "admin_ui",
        arguments: { what: "sidebar_layout", revision: revision.id },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Indelingsgeschiedenis opgeslagen, maar de auditmelding kon niet worden geschreven.";
    }
  }

  rollback(id: string): {
    ok: true;
    sidebar: SidebarItem[];
    auditWarning?: string;
  } {
    const revision = this.history.all().find((entry) => entry.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = resolveSidebar(this.settings.get());
    if (!isDeepStrictEqual(current, revision.after))
      throw new ConflictException(
        "De zijbalk is daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: { what: "sidebar_layout_rollback", revision: id },
      phase: "attempt",
    });
    this.settings.update((next) => {
      next.sidebar = { items: revision.before as never[] };
    });
    this.record(current, revision.before, id);
    return {
      ok: true,
      sidebar: resolveSidebar(this.settings.get()),
      ...(this.lastWarning ? { auditWarning: this.lastWarning } : {}),
    };
  }
}

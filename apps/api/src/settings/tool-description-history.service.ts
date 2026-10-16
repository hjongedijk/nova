import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type {
  ToolDescriptionHistory,
  ToolDescriptionRevision,
} from "@nova/contracts";
import crypto from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, listRecent } from "./history-file.js";
import { sanitize } from "../core/security/sanitize.js";
import { ToolsService } from "../tools/tools.service.js";
import { SettingsStore } from "./store/settings.store.js";

const toolPattern = /^[A-Za-z0-9_-]{1,64}$/;
const cleanText = (value: unknown): string | null => {
  if (value === null) return null;
  if (
    typeof value !== "string" ||
    value.length > 1500 ||
    sanitize(value) !== value ||
    /https?:\/\/[^\s/@:]+:[^\s/@]+@/i.test(value)
  )
    return null;
  return value;
};

/** Bounded history of custom tool descriptions only; switch state has a separate owner. */
@Injectable()
export class ToolDescriptionHistoryService {
  lastWarning: string | undefined;
  private readonly history: HistoryFile<ToolDescriptionRevision>;
  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly tools: ToolsService,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<ToolDescriptionRevision>(
      config.dataFile("tool-description-history.json"),
      (row) => {
        const before = cleanText(row.before);
        const after = cleanText(row.after);
        if (
          typeof row.tool !== "string" ||
          !toolPattern.test(row.tool) ||
          (row.before !== null && before === null) ||
          (row.after !== null && after === null) ||
          before === after
        )
          return undefined;
        return { tool: row.tool, before, after };
      },
      { durability: "file" },
    );
  }

  list(tool?: string): ToolDescriptionHistory {
    const rows = this.history.all().filter((row) => !tool || row.tool === tool);
    return listRecent(rows);
  }

  current(tool: string): string | null {
    if (
      !toolPattern.test(tool) ||
      !this.tools.list().some((row) => row.name === tool)
    )
      throw new NotFoundException("Deze tool bestaat niet.");
    return this.settings.get().toolOverrides[tool]?.description ?? null;
  }

  record(
    tool: string,
    beforeValue: string | null,
    afterValue: string | null,
  ): void {
    this.lastWarning = undefined;
    if (!toolPattern.test(tool) || beforeValue === afterValue) return;
    const before = cleanText(beforeValue);
    const after = cleanText(afterValue);
    if (
      (beforeValue !== null && before === null) ||
      (afterValue !== null && after === null)
    ) {
      this.lastWarning =
        "De beschrijving is opgeslagen, maar tekst die op een geheim lijkt is niet in de geschiedenis gezet.";
      return;
    }
    const revision: ToolDescriptionRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      tool,
      before,
      after,
    };
    try {
      this.history.append(revision);
    } catch {
      this.lastWarning =
        "De beschrijving is opgeslagen, maar de geschiedenis kon niet worden bijgewerkt.";
      return;
    }
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "SAFE",
        confirmation: "admin_ui",
        arguments: { what: "tool_description", tool, revision: revision.id },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "De geschiedenis is opgeslagen, maar de auditmelding kon niet worden geschreven.";
    }
  }

  rollback(id: string): {
    ok: true;
    description: string | null;
    auditWarning?: string;
  } {
    const revision = this.history.all().find((row) => row.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = this.current(revision.tool);
    if (!isDeepStrictEqual(current, revision.after))
      throw new ConflictException(
        "De toolbeschrijving is daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: {
        what: "tool_description_rollback",
        tool: revision.tool,
        revision: id,
      },
      phase: "attempt",
    });
    this.settings.update((next) => {
      if (
        !isDeepStrictEqual(
          next.toolOverrides[revision.tool]?.description ?? null,
          revision.after,
        )
      )
        throw new ConflictException(
          "De toolbeschrijving is intussen gewijzigd. Terugdraaien is afgebroken.",
        );
      const override = { ...next.toolOverrides[revision.tool] };
      if (revision.before === null) delete override.description;
      else override.description = revision.before;
      if (Object.keys(override).length)
        next.toolOverrides[revision.tool] = override;
      else delete next.toolOverrides[revision.tool];
    });
    this.record(revision.tool, current, revision.before);
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "CONFIRM",
        confirmation: "admin_ui",
        arguments: {
          what: "tool_description_rollback",
          tool: revision.tool,
          revision: id,
        },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "De beschrijving is hersteld, maar de auditmelding kon niet worden geschreven.";
    }
    return {
      ok: true,
      description: revision.before,
      ...(this.lastWarning ? { auditWarning: this.lastWarning } : {}),
    };
  }
}

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
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
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
  private readonly file: string;
  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly tools: ToolsService,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("tool-description-history.json");
  }

  private read(): ToolDescriptionRevision[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) return [];
      return value
        .flatMap((entry: unknown) => {
          if (!entry || typeof entry !== "object" || Array.isArray(entry))
            return [];
          const row = entry as Record<string, unknown>;
          const before = cleanText(row.before);
          const after = cleanText(row.after);
          if (
            typeof row.id !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(row.id) ||
            typeof row.at !== "string" ||
            !Number.isFinite(Date.parse(row.at)) ||
            typeof row.tool !== "string" ||
            !toolPattern.test(row.tool) ||
            (row.before !== null && before === null) ||
            (row.after !== null && after === null) ||
            before === after
          )
            return [];
          return [
            {
              id: row.id,
              at: new Date(row.at).toISOString(),
              tool: row.tool,
              before,
              after,
            },
          ];
        })
        .slice(-100);
    } catch {
      return [];
    }
  }

  private write(rows: ToolDescriptionRevision[]): void {
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
    } finally {
      fs.rmSync(temp, { force: true });
    }
  }

  list(tool?: string): ToolDescriptionHistory {
    const rows = this.read().filter((row) => !tool || row.tool === tool);
    return {
      revisions: rows.slice(-50).reverse(),
      truncated: rows.length > 50,
    };
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
      this.write([...this.read(), revision]);
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
    const revision = this.read().find((row) => row.id === id);
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

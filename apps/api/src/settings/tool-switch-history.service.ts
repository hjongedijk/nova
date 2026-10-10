import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import type { ToolSwitchRevision } from "@nova/contracts";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { ToolsService } from "../tools/tools.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { SettingsStore } from "./store/settings.store.js";

const namePattern = /^[A-Za-z0-9_-]{1,64}$/;
const toolMap = (value: unknown): Record<string, boolean> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  return Object.fromEntries(
    Object.entries(value).filter(
      ([name, enabled]) =>
        namePattern.test(name) && typeof enabled === "boolean",
    ),
  );
};

/** Stores only tool names and effective enabled booleans; descriptions and schemas never enter history. */
@Injectable()
export class ToolSwitchHistory {
  lastWarning: string | undefined;
  private readonly file: string;

  constructor(
    config: NovaConfig,
    private readonly settings: SettingsStore,
    private readonly tools: ToolsService,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("tool-switch-history.json");
  }

  private read(): ToolSwitchRevision[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) return [];
      return value.flatMap((raw: unknown) => {
        if (!raw || typeof raw !== "object" || Array.isArray(raw)) return [];
        const row = raw as Record<string, unknown>;
        if (
          typeof row.id !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(row.id) ||
          typeof row.at !== "string" ||
          !Number.isFinite(Date.parse(row.at))
        )
          return [];
        const before = toolMap(row.before);
        const after = toolMap(row.after);
        if (
          !Object.keys(before).length ||
          Object.keys(before).length !== Object.keys(after).length ||
          Object.keys(before).some((key) => !Object.hasOwn(after, key))
        )
          return [];
        return [
          {
            id: row.id,
            at: new Date(row.at).toISOString(),
            before,
            after,
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

  private write(entries: ToolSwitchRevision[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(entries.slice(-100)), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.file);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  list(): { revisions: ToolSwitchRevision[]; truncated: boolean } {
    const entries = this.read();
    return {
      revisions: entries.slice(-50).reverse(),
      truncated: entries.length > 50,
    };
  }

  current(names: string[]): Record<string, boolean> {
    const known = new Map(
      this.tools.list().map((tool) => [tool.name, tool.enabled]),
    );
    const result: Record<string, boolean> = {};
    for (const name of names) {
      if (!namePattern.test(name) || !known.has(name))
        throw new ConflictException("Een tool is niet meer beschikbaar.");
      result[name] = known.get(name)!;
    }
    return result;
  }

  record(
    before: Record<string, boolean>,
    after: Record<string, boolean>,
    revertedFrom?: string,
  ): void {
    this.lastWarning = undefined;
    const cleanBefore = toolMap(before);
    const cleanAfter = toolMap(after);
    const names = Object.keys(cleanBefore);
    if (
      !names.length ||
      names.length !== Object.keys(cleanAfter).length ||
      names.some((name) => !Object.hasOwn(cleanAfter, name)) ||
      isDeepStrictEqual(cleanBefore, cleanAfter)
    )
      return;
    const revision: ToolSwitchRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before: cleanBefore,
      after: cleanAfter,
      ...(revertedFrom ? { revertedFrom } : {}),
    };
    try {
      this.write([...this.read(), revision]);
    } catch {
      this.lastWarning =
        "De wijziging is opgeslagen, maar de schakelgeschiedenis kon niet worden bijgewerkt.";
      return;
    }
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "settings_change",
        risk: "SAFE",
        confirmation: "admin_ui",
        arguments: {
          what: "tool_switches",
          revision: revision.id,
          count: names.length,
        },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Schakelgeschiedenis opgeslagen, maar de auditmelding kon niet worden geschreven.";
    }
  }

  rollback(id: string): { ok: true; auditWarning?: string } {
    const revision = this.read().find((entry) => entry.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = this.current(Object.keys(revision.after));
    if (!isDeepStrictEqual(current, revision.after))
      throw new ConflictException(
        "Deze toolinstellingen zijn daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "CONFIRM",
      confirmation: "admin_ui",
      arguments: { what: "tool_switches_rollback", revision: id },
      phase: "attempt",
    });
    this.settings.update((next) => {
      for (const [name, enabled] of Object.entries(revision.before)) {
        const override = { ...next.toolOverrides[name] };
        if (enabled) delete override.enabled;
        else override.enabled = false;
        if (Object.keys(override).length) next.toolOverrides[name] = override;
        else delete next.toolOverrides[name];
      }
    });
    this.record(current, revision.before, revision.id);
    return {
      ok: true,
      ...(this.lastWarning ? { auditWarning: this.lastWarning } : {}),
    };
  }
}

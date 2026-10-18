import { Injectable, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import type { HomeAssistantAccessPolicy } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, listRecent, revertedFromField } from "./history-file.js";
import { HomeAssistantService } from "../home/home-assistant.service.js";

type Revision = {
  id: string;
  at: string;
  before: HomeAssistantAccessPolicy;
  after: HomeAssistantAccessPolicy;
  revertedFrom?: string;
};
const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const fields = ["mode", "areaIds", "deviceIds", "entityIds"] as const;

/** Private bounded history for the Home Assistant access allowlist. */
@Injectable()
export class HomeAssistantAccessHistory {
  private readonly history: HistoryFile<Revision>;
  lastWarning: string | undefined;

  constructor(
    config: NovaConfig,
    private readonly home: HomeAssistantService,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<Revision>(
      config.dataFile("home-assistant-access-history.json"),
      (row) =>
        this.valid(row.before) && this.valid(row.after)
          ? {
              before: row.before,
              after: row.after,
              ...revertedFromField(row),
            }
          : undefined,
      { durability: "dir" },
    );
  }

  private valid(value: unknown): value is HomeAssistantAccessPolicy {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const row = value as Record<string, unknown>;
    return (
      Object.keys(row).every((key) => fields.includes(key as never)) &&
      (row.mode === "all" || row.mode === "allowlist") &&
      ["areaIds", "deviceIds", "entityIds"].every(
        (key) =>
          Array.isArray(row[key]) &&
          (row[key] as unknown[]).length <= 1000 &&
          (row[key] as unknown[]).every(
            (id) => typeof id === "string" && id.length > 0 && id.length <= 255,
          ) &&
          new Set(row[key] as string[]).size === (row[key] as string[]).length,
      )
    );
  }

  record(
    before: HomeAssistantAccessPolicy,
    after: HomeAssistantAccessPolicy,
    revertedFrom?: string,
  ) {
    this.lastWarning = undefined;
    if (digest(before) === digest(after)) return;
    try {
      this.history.write([
        ...this.history.all(),
        {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          before,
          after,
          ...(revertedFrom ? { revertedFrom } : {}),
        },
      ]);
    } catch {
      this.lastWarning =
        "Toegang is opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
    }
  }

  list() {
    const rows = this.history.all();
    return listRecent(rows);
  }

  /** Restores the policy from before one recorded change, immediately. */
  async rollback(id: string) {
    const revision = this.history.all().find((row) => row.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = this.home.accessPolicy();
    if (digest(current) !== digest(revision.after))
      throw new NotFoundException(
        "Home Assistant-toegang is daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    const sessionId = `settings-ha-access-history:${crypto.randomUUID()}`;
    try {
      await this.home.sync();
    } catch {
      return {
        ok: false as const,
        error: "Home Assistant is niet bereikbaar. Toegang is niet teruggezet.",
      };
    }
    if (digest(this.home.accessPolicy()) !== digest(revision.after))
      return {
        ok: false as const,
        error:
          "Home Assistant-toegang is intussen gewijzigd. Kies de wijziging opnieuw.",
      };
    this.audit.record({
      sessionId,
      tool: "home_assistant_access_rollback",
      risk: "DANGEROUS",
      confirmation: "direct",
      phase: "attempt",
      arguments: { revision: id },
    });
    let restored: HomeAssistantAccessPolicy;
    try {
      restored = this.home.setAccessPolicy(revision.before);
    } catch {
      return {
        ok: false as const,
        error:
          "Een eerder gekozen apparaat bestaat niet meer. Toegang is niet teruggezet.",
      };
    }
    this.record(current, restored, id);
    try {
      this.audit.record({
        sessionId,
        tool: "home_assistant_access_rollback",
        risk: "DANGEROUS",
        confirmation: "direct",
        phase: "verified",
        arguments: { revision: id },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Toegang is teruggezet, maar de resultaatmelding kon niet worden geauditeerd.";
    }
    return {
      ok: true as const,
      policy: restored,
      ...(this.lastWarning ? { historyWarning: this.lastWarning } : {}),
    };
  }
}

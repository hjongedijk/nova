import { Injectable, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import type { ManagedTargetsAccessPolicy } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, listRecent, revertedFromField } from "./history-file.js";
import { ManagedTargetsAccessStore } from "./managed-targets-access.store.js";

const MAX_REVISIONS = 100;
type Revision = {
  id: string;
  at: string;
  before: ManagedTargetsAccessPolicy;
  after: ManagedTargetsAccessPolicy;
  revertedFrom?: string;
};
const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Private, bounded history for the locally owned infrastructure allowlist. */
@Injectable()
export class ManagedTargetsAccessHistory {
  private readonly history: HistoryFile<Revision>;
  lastWarning: string | undefined;
  constructor(
    config: NovaConfig,
    private readonly store: ManagedTargetsAccessStore,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<Revision>(
      config.dataFile("managed-targets-access-history.json"),
      (row) =>
        this.validPolicy(row.before) && this.validPolicy(row.after)
          ? {
              before: row.before,
              after: row.after,
              ...revertedFromField(row),
            }
          : undefined,
      { max: MAX_REVISIONS, durability: "dir" },
    );
  }

  private validPolicy(value: unknown): value is ManagedTargetsAccessPolicy {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return false;
    const row = value as Record<string, unknown>;
    const keys = [
      "mode",
      "proxmoxNodeIds",
      "proxmoxGuestIds",
      "termixHostIds",
      "pangolinSiteIds",
      "pangolinResourceIds",
    ];
    return (
      Object.keys(row).every((key) => keys.includes(key)) &&
      (row.mode === "all" || row.mode === "allowlist") &&
      [...keys.slice(1)].every(
        (key) =>
          Array.isArray(row[key]) &&
          (row[key] as unknown[]).length <= 200 &&
          (row[key] as unknown[]).every(
            (id) => typeof id === "string" && id.length <= 200,
          ),
      )
    );
  }

  record(
    before: ManagedTargetsAccessPolicy,
    after: ManagedTargetsAccessPolicy,
  ) {
    this.lastWarning = undefined;
    if (digest(before) === digest(after)) return;
    try {
      this.history.write([
        ...this.history.all(),
        {
          id: crypto.randomUUID(),
          at: new Date().toISOString(),
          before: structuredClone(before),
          after: structuredClone(after),
        },
      ]);
    } catch {
      this.lastWarning =
        "Doeltoegang is opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
    }
  }

  list() {
    const rows = this.history.all();
    return listRecent(rows);
  }

  /** Restores the allowlist from before one recorded change, immediately. */
  rollback(id: string) {
    const revision = this.history.all().find((row) => row.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = this.store.get();
    if (digest(current) !== digest(revision.after))
      throw new NotFoundException(
        "De doeltoegang is daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    const sessionId = `settings-targets-history:${crypto.randomUUID()}`;
    const known = {
      proxmoxNodeIds: new Set([
        ...current.proxmoxNodeIds,
        ...revision.before.proxmoxNodeIds,
      ]),
      proxmoxGuestIds: new Set([
        ...current.proxmoxGuestIds,
        ...revision.before.proxmoxGuestIds,
      ]),
      termixHostIds: new Set([
        ...current.termixHostIds,
        ...revision.before.termixHostIds,
      ]),
      pangolinSiteIds: new Set([
        ...current.pangolinSiteIds,
        ...revision.before.pangolinSiteIds,
      ]),
      pangolinResourceIds: new Set([
        ...current.pangolinResourceIds,
        ...revision.before.pangolinResourceIds,
      ]),
    };
    try {
      this.audit.record({
        sessionId,
        tool: "managed_targets_access_rollback",
        risk: "DANGEROUS",
        confirmation: "direct",
        phase: "attempt",
        arguments: { revision: id },
      });
    } catch {
      return {
        ok: false as const,
        error:
          "Terugzetten afgebroken: de wijziging kon niet worden geauditeerd.",
      };
    }
    const restored = this.store.set(revision.before, known);
    this.record(current, restored);
    let auditWarning: string | undefined;
    try {
      this.audit.record({
        sessionId,
        tool: "managed_targets_access_rollback",
        risk: "DANGEROUS",
        confirmation: "direct",
        phase: "verified",
        arguments: { revision: id },
        result: { ok: true },
      });
    } catch {
      auditWarning =
        "Terugzetten is uitgevoerd, maar de resultaatmelding kon niet worden geauditeerd.";
    }
    return {
      ok: true as const,
      policy: restored,
      ...(this.lastWarning ? { historyWarning: this.lastWarning } : {}),
      ...(auditWarning ? { auditWarning } : {}),
    };
  }
}

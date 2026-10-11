import { Injectable, NotFoundException } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { ManagedTargetsAccessPolicy } from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ManagedTargetsAccessStore } from "./managed-targets-access.store.js";

const MAX_REVISIONS = 100;
type Revision = {
  id: string;
  at: string;
  before: ManagedTargetsAccessPolicy;
  after: ManagedTargetsAccessPolicy;
  revertedFrom?: string;
};
type Draft = { sessionId: string; expiresAt: number; revision: string };
const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

/** Private, bounded history for the locally owned infrastructure allowlist. */
@Injectable()
export class ManagedTargetsAccessHistory {
  private readonly file: string;
  private readonly drafts = new Map<string, Draft>();
  lastWarning: string | undefined;
  constructor(
    config: NovaConfig,
    private readonly store: ManagedTargetsAccessStore,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
  ) {
    this.file = config.dataFile("managed-targets-access-history.json");
  }

  private read(): Revision[] {
    try {
      const value: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      if (!Array.isArray(value)) return [];
      return value.flatMap((item: unknown) => {
        if (!item || typeof item !== "object" || Array.isArray(item)) return [];
        const row = item as Record<string, unknown>;
        if (
          typeof row.id !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(row.id) ||
          typeof row.at !== "string" ||
          !Number.isFinite(Date.parse(row.at)) ||
          !this.validPolicy(row.before) ||
          !this.validPolicy(row.after)
        )
          return [];
        return [
          {
            id: row.id,
            at: new Date(row.at).toISOString(),
            before: row.before,
            after: row.after,
            ...(typeof row.revertedFrom === "string" &&
            /^[0-9a-f-]{36}$/i.test(row.revertedFrom)
              ? { revertedFrom: row.revertedFrom }
              : {}),
          },
        ];
      });
    } catch {
      return [];
    }
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

  private write(rows: Revision[]): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(rows.slice(-MAX_REVISIONS)), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      const fd = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.file);
      const directory = fs.openSync(path.dirname(this.file), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  record(
    before: ManagedTargetsAccessPolicy,
    after: ManagedTargetsAccessPolicy,
  ) {
    this.lastWarning = undefined;
    if (digest(before) === digest(after)) return;
    try {
      this.write([
        ...this.read(),
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
    const rows = this.read();
    return {
      revisions: rows.slice(-50).reverse(),
      truncated: rows.length > 50,
    };
  }

  prepareRollback(id: string) {
    for (const [confirmationId, draft] of this.drafts) {
      const pending = this.confirmations.peek(draft.sessionId);
      if (!pending || pending.expiresAt <= Date.now())
        this.drafts.delete(confirmationId);
    }
    if (this.drafts.size >= 20)
      return {
        ok: false as const,
        error: "Wacht tot een open bevestiging verloopt.",
      };
    const revision = this.read().find((row) => row.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const current = this.store.get();
    if (digest(current) !== digest(revision.after))
      throw new NotFoundException(
        "De doeltoegang is daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    const sessionId = `settings-targets-history:${crypto.randomUUID()}`;
    const action = this.confirmations.create(
      sessionId,
      "managed_targets_access_rollback",
      { revision: id, current: digest(current) },
      "DANGEROUS",
      digest(current),
      false,
    );
    this.audit.record({
      sessionId,
      tool: "managed_targets_access_rollback",
      risk: "DANGEROUS",
      confirmation: "pending_admin_ui",
      arguments: { revision: id },
    });
    this.drafts.set(action.confirmationId, {
      sessionId,
      expiresAt: action.expiresAt,
      revision: id,
    });
    return {
      ok: true as const,
      warning:
        "Terugzetten kan NOVA opnieuw toegang geven tot infrastructuurdoelen.",
      action,
    };
  }

  confirm(sessionId: string, confirmationId: string, approve: boolean) {
    const draft = this.drafts.get(confirmationId);
    const pending = this.confirmations.peek(sessionId);
    if (
      !draft ||
      draft.sessionId !== sessionId ||
      draft.expiresAt <= Date.now() ||
      !pending ||
      pending.tool !== "managed_targets_access_rollback" ||
      pending.confirmationId !== confirmationId
    )
      return {
        ok: false as const,
        error: "Bevestiging verlopen. Kies opnieuw.",
      };
    this.drafts.delete(confirmationId);
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      this.audit.record({
        sessionId,
        tool: "managed_targets_access_rollback",
        risk: "DANGEROUS",
        confirmation: "rejected_admin_ui",
        arguments: { revision: draft.revision },
        result: { ok: false },
      });
      return { ok: true as const };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action) return { ok: false as const, error: "Bevestiging verlopen." };
    const revision = this.read().find((row) => row.id === draft.revision);
    const current = this.store.get();
    if (
      !revision ||
      action.args.current !== digest(current) ||
      digest(current) !== digest(revision.after)
    )
      return {
        ok: false as const,
        error:
          "De doeltoegang is intussen gewijzigd. Kies de wijziging opnieuw.",
      };
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
        confirmation: "approved_admin_ui",
        arguments: { revision: draft.revision },
      });
    } catch {
      return {
        ok: false as const,
        error:
          "Terugzetten afgebroken: de bevestiging kon niet worden geauditeerd.",
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
        confirmation: "confirmed_admin_ui",
        arguments: { revision: draft.revision },
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

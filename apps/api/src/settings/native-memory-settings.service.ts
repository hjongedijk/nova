import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  NativeMemoryHistory,
  NativeMemoryPrepared,
  NativeMemoryRevision,
  NativeMemoryResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";

type MemorySettings = Record<string, unknown>;
type Draft = {
  sessionId: string;
  revision: string;
  enabled: boolean;
  expiresAt: number;
  rollbackRevisionId?: string;
};
const MAX_REVISIONS = 20;
const hash = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable =
  "Gateway-geheugen is niet beschikbaar. Controleer OmniRoute.";

/** Only controls OmniRoute's global memory switch; it never reads or edits memory contents. */
@Injectable()
export class NativeMemorySettingsService {
  private readonly drafts = new Map<string, Draft>();
  private inFlight = false;
  private readonly historyFile: string;
  constructor(
    config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
  ) {
    this.historyFile = config.dataFile("native-memory-settings-history.json");
  }

  private revisions(): NativeMemoryRevision[] {
    let raw: unknown;
    try {
      const stat = fs.lstatSync(this.historyFile);
      if (!stat.isFile() || stat.isSymbolicLink()) throw new Error("invalid");
      raw = JSON.parse(fs.readFileSync(this.historyFile, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new ValidationError([
        "OmniRoute-geheugengeschiedenis is niet leesbaar.",
      ]);
    }
    if (!Array.isArray(raw) || raw.length > MAX_REVISIONS)
      throw new ValidationError([
        "OmniRoute-geheugengeschiedenis is ongeldig.",
      ]);
    return raw.map((item) => {
      if (
        !item ||
        typeof item !== "object" ||
        typeof item.id !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(item.id) ||
        typeof item.at !== "string" ||
        !Number.isFinite(Date.parse(item.at)) ||
        typeof item.before !== "boolean" ||
        typeof item.after !== "boolean" ||
        item.before === item.after ||
        (item.revertedFrom !== undefined &&
          (typeof item.revertedFrom !== "string" ||
            !/^[0-9a-f-]{36}$/i.test(item.revertedFrom)))
      )
        throw new ValidationError([
          "OmniRoute-geheugengeschiedenis is ongeldig.",
        ]);
      return {
        id: item.id,
        at: new Date(item.at).toISOString(),
        before: item.before,
        after: item.after,
        ...(item.revertedFrom ? { revertedFrom: item.revertedFrom } : {}),
      };
    });
  }

  history(): NativeMemoryHistory {
    const revisions = this.revisions();
    return {
      revisions: revisions.reverse(),
      truncated: revisions.length === MAX_REVISIONS,
    };
  }

  private appendHistory(
    before: boolean,
    after: boolean,
    revertedFrom?: string,
  ): void {
    if (before === after) return;
    const revision: NativeMemoryRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before,
      after,
      ...(revertedFrom ? { revertedFrom } : {}),
    };
    const revisions = [...this.revisions(), revision].slice(-MAX_REVISIONS);
    fs.mkdirSync(path.dirname(this.historyFile), {
      recursive: true,
      mode: 0o700,
    });
    const temporary = `${this.historyFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(revisions), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      const fd = fs.openSync(temporary, "r");
      try {
        fs.fsyncSync(fd);
      } finally {
        fs.closeSync(fd);
      }
      fs.renameSync(temporary, this.historyFile);
      const directory = fs.openSync(path.dirname(this.historyFile), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private async settings(): Promise<MemorySettings> {
    const value = await this.management.request<unknown>(
      "/api/settings/memory",
    );
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new Error(unavailable);
    return value as MemorySettings;
  }

  async status(): Promise<{
    enabled: boolean | null;
    backend: string | null;
    maxTokens: number | null;
  }> {
    try {
      const settings = await this.settings();
      return {
        enabled:
          typeof settings.enabled === "boolean" ? settings.enabled : null,
        backend:
          typeof settings.primaryBackend === "string"
            ? settings.primaryBackend.slice(0, 40)
            : null,
        maxTokens:
          typeof settings.maxTokens === "number" &&
          Number.isFinite(settings.maxTokens)
            ? settings.maxTokens
            : null,
      };
    } catch {
      return { enabled: null, backend: null, maxTokens: null };
    }
  }

  async prepare(body: unknown): Promise<NativeMemoryPrepared> {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige geheugeninstelling."]);
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) =>
          !["enabled", "acknowledgeGlobal", "rollbackRevisionId"].includes(key),
      ) ||
      typeof input.enabled !== "boolean" ||
      input.acknowledgeGlobal !== true
    )
      throw new ValidationError([
        "Bevestig dat deze instelling het geheugen voor alle OmniRoute-clients wijzigt.",
      ]);
    if (
      input.rollbackRevisionId !== undefined &&
      (typeof input.rollbackRevisionId !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(input.rollbackRevisionId))
    )
      throw new ValidationError(["Ongeldige geschiedenisrevisie."]);
    for (const [id, draft] of this.drafts) {
      const pending = this.confirmations.peek(draft.sessionId);
      if (
        !pending ||
        pending.confirmationId !== id ||
        draft.expiresAt <= this.confirmations.now()
      )
        this.drafts.delete(id);
    }
    if (this.drafts.size >= 20)
      return {
        ok: false,
        error:
          "Er staan te veel geheugenwijzigingen open. Wacht tot een bevestiging verloopt.",
      };
    try {
      const current = await this.settings();
      if (typeof current.enabled !== "boolean") throw new Error(unavailable);
      const revision = hash(current);
      if (current.enabled === input.enabled)
        return { ok: false, error: "Gateway-geheugen heeft deze stand al." };
      const metadata = {
        enabled: input.enabled,
        scope: "all_gateway_clients",
        rollback: typeof input.rollbackRevisionId === "string",
      };
      this.audit.record({
        sessionId: "settings",
        tool: "native_memory_settings",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: metadata,
      });
      const action = this.confirmations.create(
        `settings-memory:${crypto.randomUUID()}`,
        "native_memory_settings",
        {
          enabled: input.enabled,
          revision,
          ...(typeof input.rollbackRevisionId === "string"
            ? { rollbackRevisionId: input.rollbackRevisionId }
            : {}),
        },
        "DANGEROUS",
        undefined,
        false,
      );
      this.drafts.set(action.confirmationId, {
        sessionId: action.sessionId,
        revision,
        enabled: input.enabled,
        expiresAt: action.expiresAt,
        ...(typeof input.rollbackRevisionId === "string"
          ? { rollbackRevisionId: input.rollbackRevisionId }
          : {}),
      });
      return { ok: true, enabled: input.enabled, action };
    } catch {
      return { ok: false, error: unavailable };
    }
  }

  async prepareRollback(
    revisionId: string,
    acknowledgeGlobal: boolean,
  ): Promise<NativeMemoryPrepared> {
    if (!/^[0-9a-f-]{36}$/i.test(revisionId) || acknowledgeGlobal !== true)
      throw new ValidationError([
        "Bevestig de clientbrede geheugenwijziging opnieuw.",
      ]);
    const revision = this.revisions().find((item) => item.id === revisionId);
    if (!revision)
      throw new ValidationError([
        "Deze geheugenwijziging staat niet in de geschiedenis.",
      ]);
    const current = await this.settings().catch(() => null);
    if (!current || current.enabled !== revision.after)
      return {
        ok: false,
        error:
          "Gateway-geheugen is intussen gewijzigd. Laad de status opnieuw.",
      };
    return this.prepare({
      enabled: revision.before,
      acknowledgeGlobal: true,
      rollbackRevisionId: revision.id,
    });
  }

  async confirm(
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ): Promise<NativeMemoryResult> {
    if (
      !/^settings-memory:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const draft = this.drafts.get(confirmationId);
    const pending = this.confirmations.peek(sessionId);
    if (
      !draft ||
      draft.sessionId !== sessionId ||
      pending?.tool !== "native_memory_settings" ||
      pending.confirmationId !== confirmationId
    )
      return {
        ok: false,
        error:
          "Deze bevestiging staat niet meer open. Laad de geheugenstatus opnieuw.",
      };
    this.drafts.delete(confirmationId);
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return {
        ok: false,
        error: "Bevestiging verlopen. Laad de geheugenstatus opnieuw.",
      };
    if (this.inFlight)
      return {
        ok: false,
        error: "Een geheugenwijziging is al bezig. Laad de status opnieuw.",
      };
    this.inFlight = true;
    try {
      let current: MemorySettings;
      try {
        current = await this.settings();
      } catch {
        return { ok: false, error: unavailable };
      }
      if (hash(current) !== draft.revision)
        return {
          ok: false,
          error:
            "OmniRoute-geheugeninstellingen zijn intussen gewijzigd. Laad de status opnieuw.",
        };
      try {
        this.audit.record({
          sessionId,
          tool: "native_memory_settings",
          risk: "DANGEROUS",
          confirmation: "confirmed_admin_ui",
          phase: "before_execute",
          arguments: { enabled: draft.enabled, scope: "all_gateway_clients" },
        });
      } catch {
        return {
          ok: false,
          error: "Wijziging niet uitgevoerd: het actielog is niet beschikbaar.",
        };
      }
      try {
        await this.management.request("/api/settings/memory", {
          method: "PUT",
          body: { enabled: draft.enabled },
        });
        const after = await this.settings();
        if (after.enabled !== draft.enabled)
          throw new Error("Persistence not verified");
        let auditWarning: string | undefined;
        try {
          this.appendHistory(
            current.enabled as boolean,
            draft.enabled,
            draft.rollbackRevisionId,
          );
        } catch {
          auditWarning =
            "Wijziging opgeslagen, maar de lokale geschiedenis kon niet worden bijgewerkt.";
        }
        try {
          this.audit.record({
            sessionId,
            tool: "native_memory_settings",
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "after_execute",
            arguments: { enabled: draft.enabled, scope: "all_gateway_clients" },
            result: { ok: true },
            verification: { persisted: true },
          });
        } catch {
          auditWarning = [
            auditWarning,
            "Opgeslagen en gecontroleerd; het actielog kon de afronding niet vastleggen.",
          ]
            .filter(Boolean)
            .join(" ");
        }
        return {
          ok: true,
          verified: true,
          enabled: draft.enabled,
          ...(auditWarning ? { auditWarning } : {}),
        };
      } catch {
        try {
          this.audit.record({
            sessionId,
            tool: "native_memory_settings",
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "after_execute",
            arguments: { enabled: draft.enabled, scope: "all_gateway_clients" },
            result: { ok: false },
            verification: { persisted: null },
          });
        } catch {
          /* Preserve the pre-execution audit. */
        }
        return {
          ok: false,
          verified: null,
          error:
            "Wijziging kon niet worden gecontroleerd. Laad de geheugenstatus opnieuw.",
        };
      }
    } finally {
      this.inFlight = false;
    }
  }
}

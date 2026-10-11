import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  OmniRouteAccountRenamePrepared,
  OmniRouteAccountRenameResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";

type AccountRow = {
  id: string;
  provider: string;
  name: string | null;
};
type AccountView = { id: string; provider: string; name: string };

const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value);
const validName = (value: unknown): value is string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= 200;
const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const unavailable =
  "Account hernoemen is niet beschikbaar. Controleer de OmniRoute-koppeling.";

/** Renames only an account's display name; never reads or changes credentials. */
@Injectable()
export class OmniRouteAccountRename {
  private readonly inFlight = new Set<string>();

  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
  ) {}

  private assertGateway(): void {
    if (
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error(unavailable);
  }

  private stored(id: string): AccountRow | undefined {
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      return db
        .prepare("SELECT id,provider,name FROM provider_connections WHERE id=?")
        .get(id) as AccountRow | undefined;
    } finally {
      db.close();
    }
  }

  private async readAccount(id: string): Promise<AccountView> {
    const response = object(
      await this.management.request(`/api/providers/${id}`),
    );
    const current = object(response.connection);
    const row = this.stored(id);
    if (
      current.id !== id ||
      typeof current.provider !== "string" ||
      typeof current.name !== "string" ||
      !row ||
      row.id !== id ||
      row.provider !== current.provider ||
      row.name !== current.name
    )
      throw new Error(unavailable);
    return { id, provider: current.provider, name: current.name };
  }

  private async assertUnique(
    provider: string,
    name: string,
    exceptId: string,
    expectedCurrentName: string,
  ): Promise<void> {
    const inventory = object(
      await this.management.request(
        `/api/providers?provider=${encodeURIComponent(provider)}&limit=200&offset=0`,
      ),
    );
    if (
      !Array.isArray(inventory.connections) ||
      typeof inventory.total !== "number" ||
      !Number.isSafeInteger(inventory.total) ||
      inventory.total > 200 ||
      inventory.total !== inventory.connections.length
    )
      throw new Error(
        "De provideraccountlijst is onvolledig; naamcontrole is afgebroken.",
      );
    const rows = inventory.connections.map(object);
    const current = rows.find((account) => account.id === exceptId);
    if (
      !current ||
      current.provider !== provider ||
      current.name !== expectedCurrentName ||
      rows.some(
        (account) =>
          typeof account.id !== "string" ||
          account.provider !== provider ||
          typeof account.name !== "string",
      )
    )
      throw new Error(
        "Provideraccountlijst en accountstatus komen niet overeen.",
      );
    if (
      rows.some((account) => {
        return (
          account.id !== exceptId &&
          typeof account.name === "string" &&
          account.name.trim().toLocaleLowerCase() === name.toLocaleLowerCase()
        );
      })
    )
      throw new Error("Er bestaat al een account met deze providernaam.");
  }

  async prepare(
    rawId: unknown,
    rawName: unknown,
    acknowledgeEffects: unknown,
  ): Promise<OmniRouteAccountRenamePrepared> {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!validId(id) || !validName(name) || acknowledgeEffects !== true)
      throw new ValidationError([
        "Kies een accountnaam van 1–200 tekens en bevestig dat de wijziging alle OmniRoute-clients en mogelijk OmniRoute Cloud raakt.",
      ]);
    try {
      this.assertGateway();
      const account = await this.readAccount(id);
      if (account.name === name)
        throw new Error("De nieuwe naam is gelijk aan de huidige naam.");
      await this.assertUnique(account.provider, name, id, account.name);
      const action = this.confirmations.create(
        `settings-account-rename:${crypto.randomUUID()}`,
        "omniroute_account_rename",
        {
          id,
          provider: account.provider,
          oldName: account.name,
          newName: name,
        },
        "DANGEROUS",
        undefined,
        false,
      );
      try {
        this.audit.record({
          sessionId: "settings",
          tool: action.tool,
          risk: "DANGEROUS",
          confirmation: "pending_admin_ui",
          arguments: {
            id,
            provider: account.provider,
            oldName: account.name,
            newName: name,
            affectsAllClients: true,
            cloudSyncMayRun: true,
          },
        });
      } catch {
        this.confirmations.cancel(action.sessionId, "rejected_admin_ui");
        return {
          ok: false,
          error: "Actielog niet beschikbaar; niets gewijzigd.",
        };
      }
      return {
        ok: true,
        id,
        provider: String(sanitize(account.provider)).slice(0, 100),
        oldName: String(sanitize(account.name)).slice(0, 200),
        newName: String(sanitize(name)).slice(0, 200),
        action,
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error &&
          /gelijk aan de huidige|bestaat al|onvolledig/.test(error.message)
            ? error.message
            : unavailable,
      };
    }
  }

  async confirm(
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ): Promise<OmniRouteAccountRenameResult> {
    if (
      !/^settings-account-rename:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige accountbevestiging."]);
    const pending = this.confirmations.peek(sessionId);
    if (
      !pending ||
      pending.tool !== "omniroute_account_rename" ||
      pending.confirmationId !== confirmationId
    )
      return { ok: false, error: "Bevestiging verlopen. Kies opnieuw." };
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return { ok: false, error: "Bevestiging verlopen. Kies opnieuw." };
    const { id, provider, oldName, newName } = action.args;
    if (
      !validId(id) ||
      typeof provider !== "string" ||
      typeof oldName !== "string" ||
      !validName(newName)
    )
      return { ok: false, error: unavailable };
    if (this.inFlight.has(id))
      return { ok: false, error: "Dit account wordt al gewijzigd." };
    this.inFlight.add(id);
    try {
      this.assertGateway();
      const before = await this.readAccount(id);
      if (before.provider !== provider || before.name !== oldName)
        return {
          ok: false,
          error:
            "Account gewijzigd sinds voorbereiding. Controleer de actuele naam.",
        };
      await this.assertUnique(provider, newName, id, oldName);
      this.audit.record({
        sessionId: "settings",
        tool: action.tool,
        risk: "DANGEROUS",
        confirmation: "confirmed_admin_ui",
        phase: "before_execute",
        arguments: {
          id,
          provider,
          oldName,
          newName,
          affectsAllClients: true,
          cloudSyncMayRun: true,
        },
      });
      try {
        await this.management.request(`/api/providers/${id}`, {
          method: "PUT",
          body: { name: newName },
        });
        const after = await this.readAccount(id);
        if (after.provider !== provider || after.name !== newName)
          throw new Error("Provideraccountnaam niet gecontroleerd");
        const result: OmniRouteAccountRenameResult = {
          ok: true,
          verified: true,
          id,
          provider: String(sanitize(provider)).slice(0, 100),
          name: String(sanitize(newName)).slice(0, 200),
        };
        try {
          this.audit.record({
            sessionId: "settings",
            tool: action.tool,
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "after_execute",
            arguments: { id, provider, oldName, newName },
            result: { ok: true },
            verification: { persisted: true },
          });
        } catch {
          result.auditWarning =
            "Naam gewijzigd en gecontroleerd; afronding kon niet in het actielog worden geschreven.";
        }
        return result;
      } catch {
        try {
          this.audit.record({
            sessionId: "settings",
            tool: action.tool,
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "after_execute",
            arguments: { id, provider, oldName, newName },
            result: { ok: false },
            verification: { persisted: null },
          });
        } catch {
          /* Keep the pre-execution audit record. */
        }
        return {
          ok: false,
          verified: null,
          error:
            "Uitkomst niet gecontroleerd. Controleer de accountnaam in OmniRoute.",
        };
      }
    } catch {
      return { ok: false, error: unavailable };
    } finally {
      this.inFlight.delete(id);
    }
  }
}

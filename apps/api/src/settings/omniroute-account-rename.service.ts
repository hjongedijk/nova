import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  OmniRouteAccountRenameHistoryEntry,
  OmniRouteAccountRenamePrepared,
  OmniRouteAccountRenameResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, revertedFromField } from "./history-file.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { object, REVISION_ID } from "./request-input.js";

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
const unavailable =
  "Account hernoemen is niet beschikbaar. Controleer de OmniRoute-koppeling.";
const renameInputError =
  "Kies een accountnaam van 1–200 tekens en bevestig dat de wijziging alle OmniRoute-clients en mogelijk OmniRoute Cloud raakt.";
const MAX_HISTORY = 100;
type RenameRevision = OmniRouteAccountRenameHistoryEntry;

/** Renames only an account's display name; never reads or changes credentials. */
@Injectable()
export class OmniRouteAccountRename {
  private readonly inFlight = new Set<string>();
  private readonly history: HistoryFile<RenameRevision>;

  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
  ) {
    this.history = new HistoryFile<RenameRevision>(
      config.dataFile("omniroute-account-rename-history.json"),
      (row) => {
        if (
          !validId(row.accountId) ||
          typeof row.provider !== "string" ||
          row.provider.length > 100 ||
          sanitize(row.provider) !== row.provider ||
          !validName(row.beforeName) ||
          row.beforeName !== row.beforeName.trim() ||
          sanitize(row.beforeName) !== row.beforeName ||
          !validName(row.afterName) ||
          row.afterName !== row.afterName.trim() ||
          sanitize(row.afterName) !== row.afterName ||
          row.beforeName === row.afterName ||
          (row.revertedFrom !== undefined &&
            (typeof row.revertedFrom !== "string" ||
              !REVISION_ID.test(row.revertedFrom)))
        )
          return undefined;
        return {
          accountId: row.accountId,
          provider: row.provider,
          beforeName: row.beforeName,
          afterName: row.afterName,
          ...revertedFromField(row),
        };
      },
      { max: MAX_HISTORY, durability: "dir" },
    );
  }

  listHistory(accountId: string): { revisions: RenameRevision[] } {
    if (!validId(accountId)) throw new ValidationError(["Ongeldig account."]);
    return {
      revisions: this.history
        .all()
        .filter((row) => row.accountId === accountId)
        .slice(-20)
        .reverse(),
    };
  }

  private rollbackRevision(
    accountId: string,
    revisionId: string,
  ): RenameRevision {
    const rows = this.history
      .all()
      .filter((row) => row.accountId === accountId);
    const selected = rows.find((row) => row.id === revisionId);
    if (!selected) throw new Error("Deze accountwijziging bestaat niet meer.");
    if (rows.at(-1)?.id !== selected.id)
      throw new Error(
        "Dit account is later gewijzigd. Herstel alleen de nieuwste wijziging.",
      );
    return selected;
  }

  async prepareRollback(
    rawId: unknown,
    rawRevisionId: unknown,
    acknowledgeEffects: unknown,
  ): Promise<OmniRouteAccountRenamePrepared> {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    const revisionId =
      typeof rawRevisionId === "string" ? rawRevisionId.trim() : "";
    if (!validId(id) || !/^[0-9a-f-]{36}$/i.test(revisionId))
      return { ok: false, error: "Ongeldige accountwijziging." };
    try {
      const revision = this.rollbackRevision(id, revisionId);
      return await this.prepare(
        id,
        revision.beforeName,
        acknowledgeEffects,
        revision.id,
      );
    } catch (error) {
      if (
        error instanceof ValidationError &&
        error.details.length === 1 &&
        error.details[0] === renameInputError
      )
        throw error;
      return {
        ok: false,
        error:
          error instanceof Error &&
          [
            "Deze accountwijziging bestaat niet meer.",
            "Dit account is later gewijzigd. Herstel alleen de nieuwste wijziging.",
          ].includes(error.message)
            ? error.message
            : "Herstel niet beschikbaar.",
      };
    }
  }

  private recordHistory(
    entry: Omit<RenameRevision, "id" | "at">,
  ): string | undefined {
    if (
      sanitize(entry.provider) !== entry.provider ||
      sanitize(entry.beforeName) !== entry.beforeName ||
      sanitize(entry.afterName) !== entry.afterName
    )
      return "Naamswijziging gecontroleerd, maar accountnamen die op geheimen lijken zijn overgeslagen in de geschiedenis.";
    try {
      this.history.write([
        ...this.history.all(),
        { ...entry, id: crypto.randomUUID(), at: new Date().toISOString() },
      ]);
      return;
    } catch {
      return "Naamswijziging gecontroleerd, maar de wijzigingsgeschiedenis kon niet worden opgeslagen.";
    }
  }

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
    rollbackRevisionId?: string,
  ): Promise<OmniRouteAccountRenamePrepared> {
    const id = typeof rawId === "string" ? rawId.trim() : "";
    const name = typeof rawName === "string" ? rawName.trim() : "";
    if (!validId(id) || !validName(name) || acknowledgeEffects !== true)
      throw new ValidationError([renameInputError]);
    try {
      this.assertGateway();
      const account = await this.readAccount(id);
      if (rollbackRevisionId) {
        const revision = this.rollbackRevision(id, rollbackRevisionId);
        if (account.name !== revision.afterName || name !== revision.beforeName)
          throw new Error("Accountnaam is gewijzigd sinds de geschiedenis.");
      }
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
          ...(rollbackRevisionId ? { rollbackRevisionId } : {}),
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
          [
            "De nieuwe naam is gelijk aan de huidige naam.",
            "Er bestaat al een account met deze providernaam.",
            "De provideraccountlijst is onvolledig; naamcontrole is afgebroken.",
            "Accountnaam is gewijzigd sinds de geschiedenis.",
            "Dit account is later gewijzigd. Herstel alleen de nieuwste wijziging.",
            "Deze accountwijziging bestaat niet meer.",
          ].includes(error.message)
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
    const rollbackRevisionId = action.args.rollbackRevisionId;
    if (
      !validId(id) ||
      typeof provider !== "string" ||
      typeof oldName !== "string" ||
      !validName(newName) ||
      (rollbackRevisionId !== undefined &&
        (typeof rollbackRevisionId !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(rollbackRevisionId)))
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
      if (typeof rollbackRevisionId === "string") {
        const revision = this.rollbackRevision(id, rollbackRevisionId);
        if (
          revision.provider !== provider ||
          revision.afterName !== oldName ||
          revision.beforeName !== newName
        )
          return {
            ok: false,
            error:
              "Geschiedenis is gewijzigd. Laad de accountgeschiedenis opnieuw.",
          };
      }
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
          ...(typeof rollbackRevisionId === "string"
            ? { rollbackRevisionId }
            : {}),
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
        result.historyWarning = this.recordHistory({
          accountId: id,
          provider,
          beforeName: oldName,
          afterName: newName,
          ...(typeof rollbackRevisionId === "string"
            ? { revertedFrom: rollbackRevisionId }
            : {}),
        });
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

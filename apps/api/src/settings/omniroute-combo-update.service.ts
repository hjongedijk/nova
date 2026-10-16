import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  OmniRouteComboUpdatePrepared,
  OmniRouteComboUpdateResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { OmniRouteComboUpdateHistory } from "./omniroute-combo-update-history.service.js";
import { object } from "./request-input.js";

type Row = { id: string; name: string; data: string; sort_order: number };
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value);
const validModelId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) &&
  !/(^|\/)\.{1,2}(\/|$)/.test(value);
const hash = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable =
  "Combo bewerken is niet beschikbaar. Controleer de OmniRoute-koppeling.";
const nameValue = (value: unknown) =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= 80
    ? value.trim()
    : "";
const modelsValue = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((item) => {
        if (typeof item === "string" && item.length <= 300) return [item];
        const row = object(item);
        return validId(row.provider) && validModelId(row.modelId)
          ? [`${row.provider}/${row.modelId}`]
          : [];
      })
    : [];

/** Allows only the name and model list to change; all other combo policy stays intact. */
@Injectable()
export class OmniRouteComboUpdate {
  private readonly inFlight = new Set<string>();
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
    private readonly barrier: RoutingManagementBarrier,
    private readonly routing: RoutingService,
    private readonly history: OmniRouteComboUpdateHistory,
  ) {}

  private row(id: string): Row | undefined {
    if (
      !validId(id) ||
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error(unavailable);
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      return db
        .prepare("SELECT id,name,data,sort_order FROM combos WHERE id=?")
        .get(id) as Row | undefined;
    } finally {
      db.close();
    }
  }

  private async current(id: string) {
    const row = this.row(id);
    if (!row || row.name.startsWith("qtSd/")) throw new Error(unavailable);
    const api = object(await this.management.request(`/api/combos/${id}`));
    const data = object(JSON.parse(row.data));
    const storedModels = modelsValue(data.models);
    if (
      api.id !== id ||
      api.name !== row.name ||
      typeof data.isActive !== "boolean" ||
      api.isActive !== data.isActive ||
      JSON.stringify(modelsValue(api.models)) !== JSON.stringify(storedModels)
    )
      throw new Error(unavailable);
    return { row, data, models: storedModels };
  }

  private async eligibleModels(): Promise<string[]> {
    const [providersRaw, catalogRaw] = await Promise.all([
      this.management.request("/api/providers?limit=200&offset=0"),
      this.management.request("/api/free-models"),
    ]);
    const providers = object(providersRaw);
    const catalog = object(catalogRaw);
    if (!Array.isArray(providers.connections) || !Array.isArray(catalog.models))
      throw new Error(unavailable);
    const active = new Set(
      providers.connections
        .map(object)
        .filter((row) => row.isActive === true && validId(row.provider))
        .map((row) => row.provider as string),
    );
    return [
      ...new Set(
        catalog.models.flatMap((value: unknown) => {
          const model = object(value);
          return validId(model.provider) &&
            validModelId(model.modelId) &&
            active.has(model.provider) &&
            typeof model.freeType === "string"
            ? [`${model.provider}/${model.modelId}`]
            : [];
        }),
      ),
    ].sort();
  }

  private async assertUniqueName(name: string, id: string): Promise<void> {
    const result = object(
      await this.management.request("/api/combos?limit=200&offset=0"),
    );
    if (!Array.isArray(result.combos)) throw new Error(unavailable);
    if (
      result.combos.some((value: unknown) => {
        const combo = object(value);
        return (
          combo.id !== id &&
          typeof combo.name === "string" &&
          combo.name.toLocaleLowerCase() === name.toLocaleLowerCase()
        );
      })
    )
      throw new Error("Er bestaat al een combo met deze naam.");
  }

  async prepare(
    id: string,
    rawName: unknown,
    rawModels: unknown,
    acknowledge: unknown,
    rollbackRevisionId?: string,
  ): Promise<OmniRouteComboUpdatePrepared> {
    const name = nameValue(rawName);
    if (
      !validId(id) ||
      !name ||
      !Array.isArray(rawModels) ||
      rawModels.length < 1 ||
      rawModels.length > 8 ||
      acknowledge !== true
    )
      throw new ValidationError([
        "Vul een naam in, kies 1–8 modellen en bevestig dat deze wijziging alle OmniRoute-clients kan raken.",
      ]);
    const models = rawModels.map((model) => {
      if (typeof model !== "string")
        throw new ValidationError(["Ongeldig model."]);
      const split = model.indexOf("/");
      const provider = model.slice(0, split);
      const modelId = model.slice(split + 1);
      if (split < 1 || !validId(provider) || !validModelId(modelId))
        throw new ValidationError(["Ongeldig model."]);
      return `${provider}/${modelId}`;
    });
    if (new Set(models).size !== models.length)
      throw new ValidationError(["Kies ieder model maar één keer."]);
    try {
      const route = this.routing.verifyForManagement();
      if (!route.ready || !route.policyVerified || !route.freeOnly)
        throw new Error(unavailable);
      const before = await this.current(id);
      if (rollbackRevisionId) {
        const revision = this.history.rollbackTarget(id, rollbackRevisionId);
        if (revision.afterRevision !== hash(before.row))
          throw new Error("Combo is intussen gewijzigd.");
      }
      if (
        name === before.row.name &&
        JSON.stringify(models) === JSON.stringify(before.models)
      )
        return { ok: false, error: "De combo is niet gewijzigd." };
      await this.assertUniqueName(name, id);
      const eligible = await this.eligibleModels();
      if (models.some((model) => !eligible.includes(model)))
        throw new Error(
          "Een gekozen model is niet meer beschikbaar via een actief account.",
        );
      const revision = hash(before.row);
      this.audit.record({
        sessionId: "settings",
        tool: "omniroute_combo_update",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: {
          id,
          revision,
          name: String(sanitize(name)),
          modelCount: models.length,
        },
      });
      return {
        ok: true,
        name: String(sanitize(name)).slice(0, 80),
        models,
        action: this.confirmations.create(
          `settings-combo-update:${crypto.randomUUID()}`,
          "omniroute_combo_update",
          {
            id,
            revision,
            name,
            models,
            eligibleRevision: hash(eligible),
            ...(rollbackRevisionId ? { rollbackRevisionId } : {}),
          },
          "DANGEROUS",
          revision,
          false,
        ),
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error &&
          [
            "Een gekozen model is niet meer beschikbaar via een actief account.",
            "Er bestaat al een combo met deze naam.",
          ].includes(error.message)
            ? error.message
            : unavailable,
      };
    }
  }

  async prepareRollback(id: string, revisionId: string) {
    const target = this.history.rollbackTarget(id, revisionId);
    const current = await this.current(id);
    if (target.afterRevision !== hash(current.row))
      return {
        ok: false as const,
        error: "De combo is later gewijzigd. Herlaad de geschiedenis.",
      };
    return this.prepare(
      id,
      target.beforeName,
      target.beforeModels,
      true,
      revisionId,
    );
  }

  async confirm(
    id: string,
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ): Promise<OmniRouteComboUpdateResult> {
    if (
      !validId(id) ||
      !/^settings-combo-update:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const pending = this.confirmations.peek(sessionId);
    if (
      !pending ||
      pending.tool !== "omniroute_combo_update" ||
      pending.args.id !== id ||
      pending.confirmationId !== confirmationId
    )
      return {
        ok: false,
        error: "Deze bevestiging staat niet meer open. Kies de combo opnieuw.",
      };
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return {
        ok: false,
        error: "Bevestiging verlopen. Kies de combo opnieuw.",
      };
    if (this.inFlight.has(id))
      return { ok: false, error: "Deze combo wordt al bewerkt." };
    this.inFlight.add(id);
    try {
      return await this.barrier.run(async (operation) => {
        let before: Awaited<ReturnType<OmniRouteComboUpdate["current"]>>;
        let historyWarning: string | undefined;
        try {
          const route = this.routing.verifyForManagement();
          if (!route.ready || !route.policyVerified || !route.freeOnly)
            throw new Error(unavailable);
          before = await this.current(id);
          if (typeof action.args.rollbackRevisionId === "string") {
            const revision = this.history.rollbackTarget(
              id,
              action.args.rollbackRevisionId,
            );
            if (revision.afterRevision !== hash(before.row))
              return {
                ok: false,
                error:
                  "De combo is intussen gewijzigd. Controleer de geschiedenis opnieuw.",
              };
          }
          const eligible = await this.eligibleModels();
          if (
            hash(before.row) !== action.args.revision ||
            hash(eligible) !== action.args.eligibleRevision
          )
            return {
              ok: false,
              error:
                "De combo of modellen zijn gewijzigd. Controleer de keuze opnieuw.",
            };
          const name = nameValue(action.args.name);
          const models = Array.isArray(action.args.models)
            ? (action.args.models as string[])
            : [];
          if (
            !name ||
            !models.length ||
            models.some((model) => !eligible.includes(model))
          )
            throw new Error(unavailable);
          await this.assertUniqueName(name, id);
          this.audit.record({
            sessionId: "settings",
            tool: action.tool,
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "before_execute",
            arguments: {
              id,
              revision: action.args.revision,
              name: String(sanitize(name)),
              modelCount: models.length,
            },
          });
          operation.block("policy_change");
        } catch {
          return { ok: false, error: unavailable };
        }
        try {
          const name = nameValue(action.args.name);
          const models = action.args.models as string[];
          await this.management.request(`/api/combos/${id}`, {
            method: "PUT",
            body: { name, models },
          });
          const after = await this.current(id);
          if (
            after.row.name !== name ||
            JSON.stringify(after.models) !== JSON.stringify(models)
          )
            throw new Error("Combo update not verified");
          historyWarning = this.history.record({
            comboId: id,
            beforeName: before.row.name,
            afterName: after.row.name,
            beforeModels: before.models,
            afterModels: after.models,
            beforeRevision: hash(before.row),
            afterRevision: hash(after.row),
            ...(typeof action.args.rollbackRevisionId === "string"
              ? { revertedFrom: action.args.rollbackRevisionId }
              : {}),
          });
        } catch {
          try {
            this.audit.record({
              sessionId: "settings",
              tool: action.tool,
              risk: "DANGEROUS",
              confirmation: "confirmed_admin_ui",
              phase: "after_execute",
              arguments: { id },
              result: { ok: false },
              verification: { persisted: null, routeReady: false },
            });
          } catch {
            /* keep initial audit */
          }
          return {
            ok: false,
            verified: null,
            routeReady: false,
            error:
              "Wijziging kon niet worden gecontroleerd. NOVA houdt AI geblokkeerd; controleer de combo in OmniRoute.",
          };
        }
        let routeReady = false;
        try {
          const status = this.routing.verifyForManagement();
          if (status.ready && status.policyVerified && status.freeOnly)
            routeReady = operation.releaseAfterVerification().ready;
        } catch {
          /* fail closed */
        }
        const result: OmniRouteComboUpdateResult = {
          ok: true,
          verified: true,
          routeReady,
          ...(historyWarning ? { historyWarning } : {}),
        };
        try {
          this.audit.record({
            sessionId: "settings",
            tool: action.tool,
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "after_execute",
            arguments: { id },
            result: { ok: true },
            verification: { persisted: true, routeReady },
          });
        } catch {
          result.auditWarning =
            "Opgeslagen en gecontroleerd; afronding kon niet in het actielog worden geschreven.";
        }
        return result;
      });
    } catch {
      return {
        ok: false,
        error:
          "Combo bewerken kon niet starten. Controleer koppeling en gratis route.",
      };
    } finally {
      this.inFlight.delete(id);
    }
  }
}

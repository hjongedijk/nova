import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  OmniRouteComboCreatePrepared,
  OmniRouteComboCreateResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import { RoutingService } from "../routing/routing.service.js";
import { object } from "./request-input.js";

type Model = { provider: string; modelId: string };
type ComboRow = { id: string; name: string; data: string };
const validId = (value: unknown): value is string =>
  typeof value === "string" && /^[a-zA-Z0-9_.-]{1,100}$/.test(value);
const validModelId = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_.:/-]{1,200}$/.test(value) &&
  !/(^|\/)\.{1,2}(\/|$)/.test(value);
const revision = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const unavailable =
  "Combo aanmaken is niet beschikbaar. Controleer de OmniRoute-koppeling.";
const comboName = (value: unknown): string =>
  typeof value === "string" &&
  value.trim().length > 0 &&
  value.trim().length <= 80
    ? value.trim()
    : "";
const modelEntries = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.flatMap((entry: unknown) => {
        if (typeof entry === "string") return [entry];
        const model = object(entry);
        const provider = model.provider;
        const id = model.modelId ?? model.model ?? model.name;
        return validId(provider) && validModelId(id)
          ? [`${provider}/${id}`]
          : [];
      })
    : [];

/** Creates a deliberately narrow combo without prompt, tools, or provider settings. */
@Injectable()
export class OmniRouteComboCreate {
  private readonly inFlight = new Set<string>();
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
    private readonly barrier: RoutingManagementBarrier,
    private readonly routing: RoutingService,
  ) {}

  private async eligibleModels(): Promise<Model[]> {
    if (
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error(unavailable);
    const [providersRaw, catalogRaw] = await Promise.all([
      this.management.request("/api/providers?limit=200&offset=0"),
      this.management.request("/api/free-models"),
    ]);
    const providers = object(providersRaw);
    const catalog = object(catalogRaw);
    if (!Array.isArray(providers.connections) || !Array.isArray(catalog.models))
      throw new Error(unavailable);
    const activeProviders = new Set(
      providers.connections
        .map(object)
        .filter((row) => row.isActive === true && validId(row.provider))
        .map((row) => row.provider as string),
    );
    const seen = new Set<string>();
    return catalog.models.flatMap((value: unknown) => {
      const row = object(value);
      const provider = row.provider;
      const modelId = row.modelId;
      if (
        !validId(provider) ||
        !validModelId(modelId) ||
        !activeProviders.has(provider) ||
        typeof row.freeType !== "string" ||
        row.freeType.length > 60
      )
        return [];
      const key = `${provider}/${modelId}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ provider, modelId }];
    });
  }

  private async assertUnique(name: string) {
    const result = object(
      await this.management.request("/api/combos?limit=200&offset=0"),
    );
    if (!Array.isArray(result.combos)) throw new Error(unavailable);
    if (
      result.combos
        .map(object)
        .some(
          (combo) =>
            typeof combo.name === "string" &&
            combo.name.toLowerCase() === name.toLowerCase(),
        )
    )
      throw new Error("Er bestaat al een combo met deze naam.");
  }

  private async inventoryRevision(models: Model[]) {
    const eligible = await this.eligibleModels();
    const current = new Set(
      eligible.map((model) => `${model.provider}/${model.modelId}`),
    );
    if (
      models.some((model) => !current.has(`${model.provider}/${model.modelId}`))
    )
      throw new Error(
        "Een gekozen model is niet meer beschikbaar via een actief account.",
      );
    return revision(eligible);
  }

  async prepare(
    rawName: unknown,
    rawModels: unknown,
    acknowledgeGlobalEffect: unknown,
  ): Promise<OmniRouteComboCreatePrepared> {
    const name = comboName(rawName);
    if (
      !name ||
      !Array.isArray(rawModels) ||
      rawModels.length < 1 ||
      rawModels.length > 8 ||
      acknowledgeGlobalEffect !== true
    )
      throw new ValidationError([
        "Vul een naam in, kies 1–8 modellen en bevestig dat deze combo zichtbaar wordt voor OmniRoute-clients.",
      ]);
    const models: Model[] = [];
    for (const value of rawModels) {
      if (typeof value !== "string" || !validModelId(value))
        throw new ValidationError(["Een gekozen model is ongeldig."]);
      const split = value.indexOf("/");
      const provider = value.slice(0, split);
      const modelId = value.slice(split + 1);
      if (!validId(provider) || !validModelId(modelId))
        throw new ValidationError(["Een gekozen model is ongeldig."]);
      models.push({ provider, modelId });
    }
    if (
      new Set(models.map((model) => `${model.provider}/${model.modelId}`))
        .size !== models.length
    )
      throw new ValidationError(["Kies ieder model maar één keer."]);
    try {
      const route = this.routing.verifyForManagement();
      if (!route.ready || !route.policyVerified || !route.freeOnly)
        throw new Error(unavailable);
      await this.assertUnique(name);
      const inventoryRevision = await this.inventoryRevision(models);
      const args = { name, models, inventoryRevision };
      this.audit.record({
        sessionId: "settings",
        tool: "omniroute_combo_create",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: {
          name: String(sanitize(name)).slice(0, 80),
          models,
          inventoryRevision,
        },
      });
      return {
        ok: true,
        name: String(sanitize(name)).slice(0, 80),
        models: models.map((model) => `${model.provider}/${model.modelId}`),
        action: this.confirmations.create(
          `settings-combo-create:${crypto.randomUUID()}`,
          "omniroute_combo_create",
          args,
          "DANGEROUS",
          inventoryRevision,
          false,
        ),
      };
    } catch (error) {
      return {
        ok: false,
        error:
          error instanceof Error &&
          error.message === "Er bestaat al een combo met deze naam."
            ? "Er bestaat al een combo met deze naam."
            : unavailable,
      };
    }
  }

  private stored(id: string): ComboRow | undefined {
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      return db
        .prepare("SELECT id,name,data FROM combos WHERE id=?")
        .get(id) as ComboRow | undefined;
    } finally {
      db.close();
    }
  }

  async confirm(
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ): Promise<OmniRouteComboCreateResult> {
    if (
      !/^settings-combo-create:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const pending = this.confirmations.peek(sessionId);
    if (
      !pending ||
      pending.tool !== "omniroute_combo_create" ||
      pending.confirmationId !== confirmationId
    )
      return {
        ok: false,
        error:
          "Deze bevestiging staat niet meer open. Vul de combo opnieuw in.",
      };
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return {
        ok: false,
        error: "Bevestiging verlopen. Vul de combo opnieuw in.",
      };
    const key = String(action.args.name);
    if (this.inFlight.has(key))
      return { ok: false, error: "Deze combo wordt al aangemaakt." };
    this.inFlight.add(key);
    try {
      return await this.barrier.run(async (operation) => {
        let name: string;
        let models: Model[];
        try {
          const route = this.routing.verifyForManagement();
          if (!route.ready || !route.policyVerified || !route.freeOnly)
            return { ok: false, error: unavailable };
          name = comboName(action.args.name);
          models = Array.isArray(action.args.models)
            ? (action.args.models as Model[])
            : [];
          if (
            !name ||
            !models.length ||
            (await this.inventoryRevision(models)) !==
              action.args.inventoryRevision
          )
            return {
              ok: false,
              error:
                "De modellen of accounts zijn gewijzigd. Controleer de keuze opnieuw.",
            };
          await this.assertUnique(name);
          this.audit.record({
            sessionId: "settings",
            tool: action.tool,
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "before_execute",
            arguments: {
              name,
              modelCount: models.length,
              inventoryRevision: action.args.inventoryRevision,
            },
          });
          operation.block("policy_change");
        } catch {
          return { ok: false, error: unavailable };
        }
        try {
          const created = object(
            await this.management.request("/api/combos", {
              method: "POST",
              body: {
                name,
                models: models.map(
                  (model) => `${model.provider}/${model.modelId}`,
                ),
              },
            }),
          );
          const id = created.id;
          if (!validId(id)) throw new Error("Combo ID missing");
          const row = this.stored(id);
          const data =
            row && typeof row.data === "string"
              ? object(JSON.parse(row.data))
              : {};
          const storedModels = modelEntries(data.models);
          if (
            typeof data.isActive !== "boolean" ||
            typeof created.isActive !== "boolean" ||
            data.isActive !== created.isActive
          )
            throw new Error("Combo activation state not verified");
          const expected = models.map(
            (model) => `${model.provider}/${model.modelId}`,
          );
          if (
            !row ||
            row.id !== id ||
            row.name !== name ||
            created.name !== name ||
            JSON.stringify(storedModels) !== JSON.stringify(expected) ||
            JSON.stringify(modelEntries(created.models)) !==
              JSON.stringify(expected)
          )
            throw new Error("Combo persistence not verified");
          let routeReady = false;
          try {
            const status = this.routing.verifyForManagement();
            if (status.ready && status.policyVerified && status.freeOnly)
              routeReady = operation.releaseAfterVerification().ready;
          } catch {
            /* inference stop retained */
          }
          const result: OmniRouteComboCreateResult = {
            ok: true,
            verified: true,
            id,
            name,
            routeReady,
          };
          try {
            this.audit.record({
              sessionId: "settings",
              tool: action.tool,
              risk: "DANGEROUS",
              confirmation: "confirmed_admin_ui",
              phase: "after_execute",
              arguments: { id, name, modelCount: models.length },
              result: { ok: true },
              verification: { persisted: true, routeReady },
            });
          } catch {
            result.auditWarning =
              "Opgeslagen en gecontroleerd; afronding kon niet in het actielog worden geschreven.";
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
              arguments: { name, modelCount: models.length },
              result: { ok: false },
              verification: { persisted: null, routeReady: false },
            });
          } catch {
            /* before-execution record remains */
          }
          return {
            ok: false,
            verified: null,
            routeReady: false,
            error:
              "Uitkomst niet gecontroleerd. NOVA houdt AI geblokkeerd; controleer de combo in OmniRoute.",
          };
        }
      });
    } catch {
      return {
        ok: false,
        error:
          "Combo aanmaken kon niet starten. Controleer koppeling en gratis route.",
      };
    } finally {
      this.inFlight.delete(key);
    }
  }
}

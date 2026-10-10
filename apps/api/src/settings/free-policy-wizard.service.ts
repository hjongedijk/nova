import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type {
  FreePolicyOptions,
  FreePolicyPrepared,
  FreePolicyResult,
} from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";
import {
  connectionFingerprint,
  type CredentialConnection,
} from "../routing/connection-binding.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import {
  buildFreePolicyPlan,
  type FreePolicyPlan,
  type PlanAccount,
  type PlanModel,
} from "./free-policy-plan.js";
import { ValidationError } from "../core/errors/validation.error.js";

const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const identifier = (value: unknown) =>
  typeof value === "string" &&
  /^[a-zA-Z0-9_.-]{1,100}$/.test(value) &&
  sanitize(value) === value
    ? value
    : "";
const uuid = (value: unknown): value is string =>
  typeof value === "string" &&
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
const unavailable =
  "Gratis beleid kon niet worden voorbereid. Controleer de gateway, NOVA-sleutel en accounts.";
const settingNames = [
  "_settingsRevision",
  "freeAccessPolicy",
  "hidePaidModels",
  "excludeTosAvoid",
  "modelVisibilityAllowlist",
  "blockedProviders",
];
type KeyRow = {
  id: string;
  model_access_mode: string;
  allowed_models: string | null;
  allowed_connections: string | null;
  allowed_combos: string | null;
  allow_auto_combos: number;
};
type Snapshot = {
  accounts: PlanAccount[];
  key: KeyRow;
  settings: Record<string, unknown>;
  revision: number;
  overrides: string[];
  policyDigest: string;
};
type VerifiedPlan = Omit<FreePolicyPlan, "catalog"> & {
  catalog: (Omit<FreePolicyPlan["catalog"][number], "nativeAutoEligible"> & {
    nativeAutoEligible: true;
  })[];
};
type Draft = {
  plan: FreePolicyPlan;
  binding: string;
  sessionId: string;
  expiresAt: number;
};

/** A complete policy replacement, kept blocked until configuration and operator account evidence are bound. */
@Injectable()
export class FreePolicyWizard implements OnModuleDestroy {
  private readonly inventorySecret = crypto.randomBytes(32);
  private readonly drafts = new Map<string, Draft>();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
    private readonly barrier: RoutingManagementBarrier,
  ) {}
  private drop(id: string): void {
    this.drafts.delete(id);
    clearTimeout(this.timers.get(id));
    this.timers.delete(id);
  }
  onModuleDestroy(): void {
    for (const id of this.drafts.keys()) this.drop(id);
  }
  private assertGateway(): void {
    if (
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured ||
      this.config.omniModel !== "auto"
    )
      throw new Error(unavailable);
  }
  private policyDigest(): string {
    const filename = this.config.dataFile("free-routing-policy.json");
    try {
      if (fs.statSync(filename).size > 1_000_000) throw new Error(unavailable);
      return digest(fs.readFileSync(filename, "utf8"));
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT")
        return digest("absent");
      throw error;
    }
  }
  private snapshot(): Snapshot {
    this.assertGateway();
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      const rows = db
        .prepare(
          "SELECT id,provider,name,is_active,auth_type,api_key FROM provider_connections ORDER BY id LIMIT 201",
        )
        .all() as unknown as (CredentialConnection & {
        name: string | null;
        is_active: number;
      })[];
      if (rows.length > 200) throw new Error(unavailable);
      const accounts: PlanAccount[] = rows.map((row) => ({
        id: row.id,
        provider: row.provider,
        name: String(sanitize(row.name || row.provider)).slice(0, 200),
        active: row.is_active === 1,
        authType: row.auth_type || "",
        credentialPresent:
          typeof row.api_key === "string" && row.api_key.trim().length > 0,
        fingerprint: connectionFingerprint(row),
      }));
      const key = db
        .prepare(
          "SELECT id,model_access_mode,allowed_models,allowed_connections,allowed_combos,allow_auto_combos FROM api_keys WHERE key=? AND is_active=1 AND revoked_at IS NULL",
        )
        .get(this.config.omniKey) as KeyRow | undefined;
      if (!key || !uuid(key.id)) throw new Error(unavailable);
      const settings: Record<string, unknown> = {};
      for (const name of settingNames) {
        const row = db
          .prepare(
            "SELECT value FROM key_value WHERE namespace='settings' AND key=?",
          )
          .get(name) as { value: string } | undefined;
        if (row) settings[name] = JSON.parse(row.value);
      }
      const revision = settings._settingsRevision ?? 0;
      if (
        typeof revision !== "number" ||
        !Number.isSafeInteger(revision) ||
        revision < 0
      )
        throw new Error(unavailable);
      const overrides = (
        db
          .prepare(
            "SELECT connection_id FROM auto_candidate_overrides WHERE api_key_id=? AND auto_channel='auto' AND excluded=1 ORDER BY connection_id",
          )
          .all(key.id) as { connection_id: string }[]
      ).map((row) => row.connection_id);
      return {
        accounts,
        key,
        settings,
        revision,
        overrides,
        policyDigest: this.policyDigest(),
      };
    } finally {
      db.close();
    }
  }
  private async models(): Promise<PlanModel[]> {
    this.assertGateway();
    const data = object(await this.management.request("/api/free-models"));
    if (!Array.isArray(data.models) || data.models.length > 500)
      throw new Error(unavailable);
    return data.models.flatMap((raw) => {
      const row = object(raw);
      const provider = identifier(row.provider);
      if (
        !provider ||
        typeof row.modelId !== "string" ||
        !/^[a-zA-Z0-9_.:/-]{1,200}$/.test(row.modelId) ||
        sanitize(row.modelId) !== row.modelId
      )
        return [];
      return [
        {
          provider,
          modelId: row.modelId,
          name:
            typeof row.displayName === "string"
              ? String(sanitize(row.displayName)).slice(0, 200)
              : row.modelId,
          freeType:
            typeof row.freeType === "string"
              ? String(sanitize(row.freeType)).slice(0, 60)
              : "",
          tos: typeof row.tos === "string" ? row.tos : "",
        },
      ];
    });
  }
  private inventoryToken(snapshot: Snapshot, expiresAt: number): string {
    const signature = crypto
      .createHmac("sha256", this.inventorySecret)
      .update(JSON.stringify({ snapshot, expiresAt }))
      .digest("hex");
    return `${expiresAt}.${signature}`;
  }
  private verifyInventory(token: unknown, snapshot: Snapshot): void {
    if (typeof token !== "string" || !/^\d{1,16}\.[a-f0-9]{64}$/.test(token))
      throw new Error("Inventory acknowledgement missing");
    const expiresAt = Number(token.split(".")[0]);
    const now = this.confirmations.now();
    if (
      !Number.isSafeInteger(expiresAt) ||
      expiresAt <= now ||
      expiresAt > now + 600_000
    )
      throw new Error("Inventory acknowledgement expired");
    const expected = this.inventoryToken(snapshot, expiresAt);
    if (!crypto.timingSafeEqual(Buffer.from(token), Buffer.from(expected)))
      throw new Error("Inventory changed; renew account attestations");
  }
  async options(): Promise<FreePolicyOptions> {
    try {
      const snapshot = this.snapshot();
      const models = await this.models();
      return {
        available: true,
        inventoryToken: this.inventoryToken(
          snapshot,
          this.confirmations.now() + 600_000,
        ),
        accounts: snapshot.accounts
          .filter(
            (account) =>
              account.active &&
              account.authType === "apikey" &&
              account.credentialPresent &&
              uuid(account.id) &&
              identifier(account.provider),
          )
          .map(({ id, provider, name }) => ({ id, provider, name })),
        models: models.filter(
          (model) =>
            /^recurring-/.test(model.freeType) &&
            ["ok", "caution"].includes(model.tos),
        ),
        verified: false,
      };
    } catch {
      return {
        available: false,
        error: unavailable,
        accounts: [],
        models: [],
        verified: false,
      };
    }
  }
  async prepare(input: unknown): Promise<FreePolicyPrepared> {
    const value = object(input);
    if (
      ![
        "acknowledgeBillingDisabled",
        "acknowledgeHardStop",
        "acknowledgeTerms",
        "acknowledgeAllClients",
        "acknowledgeQuotaRefresh",
      ].every((key) => value[key] === true)
    )
      throw new ValidationError([
        "Controleer en bevestig facturering, harde limieten, voorwaarden en de gevolgen voor alle clients.",
      ]);
    for (const [id, draft] of this.drafts)
      if (
        draft.expiresAt <= this.confirmations.now() ||
        !this.confirmations.has(draft.sessionId)
      )
        this.drop(id);
    if (this.drafts.size >= 20)
      return {
        ok: false,
        error:
          "Er staan te veel beleidswijzigingen open. Annuleer of wacht tot ze verlopen.",
      };
    try {
      const snapshot = this.snapshot();
      this.verifyInventory(value.inventoryToken, snapshot);
      const { inventoryToken: _token, ...planInput } = value;
      void _token;
      const models = await this.models();
      const knownProviders = [
        ...snapshot.accounts.map((account) => account.provider),
        ...(Array.isArray(snapshot.settings.blockedProviders)
          ? snapshot.settings.blockedProviders.filter(
              (provider): provider is string => typeof provider === "string",
            )
          : []),
      ]
        .map(identifier)
        .filter(Boolean);
      const plan = buildFreePolicyPlan(
        planInput,
        snapshot.accounts,
        models,
        knownProviders,
      );
      if (
        snapshot.overrides.some((id) => plan.verifiedConnectionIds.includes(id))
      )
        return {
          ok: false,
          error:
            "Een gekozen account is uitgesloten voor NOVA. Verwijder die uitsluiting in OmniRoute voordat je beleid maakt.",
        };
      const metadata = {
        models: plan.enabledModels,
        accounts: plan.verifiedConnectionIds.length,
        evidenceSource: "operator-account",
        nativeQuotaVerified: false,
      };
      this.audit.record({
        sessionId: "settings",
        tool: "free_policy_replace",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: metadata,
      });
      if (this.drafts.size >= 20)
        return {
          ok: false,
          error:
            "Er staan te veel beleidswijzigingen open. Annuleer of wacht tot ze verlopen.",
        };
      const action = this.confirmations.create(
        `settings-policy:${crypto.randomUUID()}`,
        "free_policy_replace",
        metadata,
        "DANGEROUS",
        undefined,
        false,
      );
      this.drafts.set(action.confirmationId, {
        plan,
        binding: digest(snapshot),
        sessionId: action.sessionId,
        expiresAt: action.expiresAt,
      });
      const timer = setTimeout(
        () => this.drop(action.confirmationId),
        Math.max(0, action.expiresAt - this.confirmations.now()),
      );
      timer.unref();
      this.timers.set(action.confirmationId, timer);
      return { ok: true, action };
    } catch (error) {
      if (error instanceof ValidationError) throw error;
      return { ok: false, error: unavailable };
    }
  }
  private verifyWrites(snapshot: Snapshot, plan: FreePolicyPlan): void {
    const settings = snapshot.settings;
    if (
      settings.freeAccessPolicy !== "strict" ||
      settings.hidePaidModels !== true ||
      settings.excludeTosAvoid !== true ||
      digest(settings.modelVisibilityAllowlist) !==
        digest(plan.nativeModelAllowlist) ||
      digest(settings.blockedProviders) !== digest(plan.blockedProviders) ||
      snapshot.key.model_access_mode !== "restricted" ||
      digest(JSON.parse(snapshot.key.allowed_models || "[]")) !==
        digest(["auto"]) ||
      digest(JSON.parse(snapshot.key.allowed_connections || "[]")) !==
        digest(plan.verifiedConnectionIds) ||
      digest(JSON.parse(snapshot.key.allowed_combos || "[]")) !== digest([]) ||
      snapshot.key.allow_auto_combos !== 1 ||
      snapshot.overrides.some((id) => plan.verifiedConnectionIds.includes(id))
    )
      throw new Error("Native policy persistence not verified");
    for (const binding of plan.verifiedConnections) {
      const row = snapshot.accounts.find(
        (account) => account.id === binding.id,
      );
      if (
        !row?.active ||
        row.provider !== binding.provider ||
        row.fingerprint !== binding.fingerprint
      )
        throw new Error("Account binding changed");
    }
  }
  private verifyStructure(raw: unknown, plan: FreePolicyPlan): void {
    const data = object(raw);
    if (
      data.channel !== "auto" ||
      !Array.isArray(data.candidates) ||
      data.candidates.length > 2000
    )
      throw new Error("Native pool unavailable");
    const rows = data.candidates.map(object);
    for (const model of plan.catalog) {
      const canonical = `${model.provider}/${model.modelId}`;
      const binding = plan.verifiedConnections.find(
        (account) => account.provider === model.provider,
      );
      const matches = rows.filter(
        (row) =>
          row.provider === model.provider &&
          row.model === canonical &&
          row.connectionId === binding?.id,
      );
      const row = matches[0];
      if (
        matches.length !== 1 ||
        !row ||
        row.connectionId !== binding?.id ||
        row.modelStr !== canonical ||
        row.reachable !== true ||
        row.excluded !== false ||
        row.breakerState !== "CLOSED" ||
        row.connectionCooldown !== false ||
        row.modelLocked !== false
      )
        throw new Error("Selected native account structure not verified");
    }
  }
  private savePolicy(plan: VerifiedPlan): void {
    const filename = this.config.dataFile("free-routing-policy.json");
    const temporary = `${filename}.${crypto.randomUUID()}.tmp`;
    const content = JSON.stringify(plan, null, 2) + "\n";
    if (Buffer.byteLength(content) > 1_000_000)
      throw new Error("Policy too large");
    if (fs.existsSync(filename) && !fs.existsSync(`${filename}.backup`)) {
      const previous = fs.readFileSync(filename);
      const backupPath = `${filename}.backup`;
      const backupTemporary = `${backupPath}.${crypto.randomUUID()}.tmp`;
      let backup: number | undefined;
      try {
        backup = fs.openSync(backupTemporary, "wx", 0o600);
        fs.writeFileSync(backup, previous);
        fs.fsyncSync(backup);
        fs.closeSync(backup);
        backup = undefined;
        fs.linkSync(backupTemporary, backupPath);
        const directory = fs.openSync(path.dirname(filename), "r");
        try {
          fs.fsyncSync(directory);
        } finally {
          fs.closeSync(directory);
        }
      } finally {
        if (backup !== undefined) fs.closeSync(backup);
        fs.rmSync(backupTemporary, { force: true });
      }
    }
    let descriptor: number | undefined;
    try {
      descriptor = fs.openSync(temporary, "wx", 0o600);
      fs.writeFileSync(descriptor, content);
      fs.fsyncSync(descriptor);
      fs.closeSync(descriptor);
      descriptor = undefined;
      fs.renameSync(temporary, filename);
      const directory = fs.openSync(path.dirname(filename), "r");
      try {
        fs.fsyncSync(directory);
      } finally {
        fs.closeSync(directory);
      }
    } finally {
      if (descriptor !== undefined) fs.closeSync(descriptor);
      fs.rmSync(temporary, { force: true });
    }
  }
  async confirm(
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ): Promise<FreePolicyResult> {
    if (
      !/^settings-policy:[0-9a-f-]{36}$/i.test(sessionId) ||
      !uuid(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const draft = this.drafts.get(confirmationId);
    const pending = this.confirmations.peek(sessionId);
    if (
      !draft ||
      draft.sessionId !== sessionId ||
      !pending ||
      pending.tool !== "free_policy_replace" ||
      pending.confirmationId !== confirmationId
    )
      return {
        ok: false,
        error:
          "Dit concept staat niet meer open. Bereid het beleid opnieuw voor.",
      };
    this.drop(confirmationId);
    if (!approve) {
      this.confirmations.cancel(sessionId, "rejected_admin_ui");
      return { ok: true };
    }
    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return {
        ok: false,
        error: "Bevestiging verlopen. Bereid het beleid opnieuw voor.",
      };
    try {
      return await this.barrier.run(async (operation) => {
        const before = this.snapshot();
        if (digest(before) !== draft.binding)
          return {
            ok: false,
            error:
              "Accounts, gateway-instellingen of beleid zijn ondertussen gewijzigd. Bereid het beleid opnieuw voor.",
          };
        const plan = draft.plan;
        const metadata = {
          models: plan.enabledModels,
          accounts: plan.verifiedConnectionIds.length,
          evidenceSource: "operator-account",
          nativeQuotaVerified: false,
        };
        this.audit.record({
          sessionId: "settings",
          tool: action.tool,
          risk: "DANGEROUS",
          confirmation: "confirmed_admin_ui",
          phase: "before_execute",
          arguments: metadata,
        });
        operation.block("policy_change");
        try {
          await this.management.request("/api/settings", {
            method: "PATCH",
            body: {
              expectedRevision: before.revision,
              freeAccessPolicy: "strict",
              hidePaidModels: true,
              excludeTosAvoid: true,
              modelVisibilityAllowlist: plan.nativeModelAllowlist,
              blockedProviders: plan.blockedProviders,
            },
          });
          await this.management.request(`/api/keys/${before.key.id}`, {
            method: "PATCH",
            body: {
              modelAccessMode: "restricted",
              connectionAccessMode: "restricted",
              allowedModels: ["auto"],
              allowedCombos: [],
              allowedConnections: plan.verifiedConnectionIds,
              allowAutoCombos: true,
            },
          });
          const persisted = this.snapshot();
          if (
            persisted.key.id !== before.key.id ||
            persisted.revision !== before.revision + 1
          )
            throw new Error("Native revision changed");
          this.verifyWrites(persisted, plan);
          const candidates = await this.management.request(
            "/api/v1/auto-combo/auto/candidates",
          );
          this.verifyStructure(candidates, plan);
          const latest = this.snapshot();
          if (
            latest.key.id !== before.key.id ||
            latest.revision !== persisted.revision ||
            latest.policyDigest !== before.policyDigest
          )
            throw new Error(
              "Native or local policy changed during verification",
            );
          this.verifyWrites(latest, plan);
          const verifiedPlan: VerifiedPlan = {
            ...plan,
            catalog: plan.catalog.map((model) => ({
              ...model,
              nativeAutoEligible: true,
            })),
          };
          this.savePolicy(verifiedPlan);
          const status = operation.releaseAfterVerification();
          const result: FreePolicyResult = {
            ok: true,
            verified: true,
            routeReady: status.ready,
            evidenceSource: "operator-account",
            nativeQuotaVerified: false,
          };
          try {
            this.audit.record({
              sessionId: "settings",
              tool: action.tool,
              risk: "DANGEROUS",
              confirmation: "confirmed_admin_ui",
              phase: "after_execute",
              arguments: metadata,
              result: { ok: true },
              verification: { persisted: true, routeReady: status.ready },
            });
          } catch {
            result.auditWarning =
              "Beleid opgeslagen en gecontroleerd; afronding kon niet in het actielog worden geschreven.";
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
              arguments: metadata,
              result: { ok: false },
              verification: { persisted: null, routeReady: false },
            });
          } catch {
            /* Before-execution audit remains available. */
          }
          return {
            ok: false,
            verified: null,
            routeReady: false,
            error:
              "Beleid is niet volledig geverifieerd. Gateway-instellingen kunnen al gewijzigd zijn. AI blijft geblokkeerd. Accountbinding en opgeslagen instellingen moeten overeenkomen; native quota is niet als kostenbewijs gebruikt. Controleer OmniRoute en bereid het beleid opnieuw voor.",
          };
        }
      });
    } catch {
      return {
        ok: false,
        error:
          "Beleidswijziging kon niet starten. Controleer de koppeling en probeer opnieuw met verse toestemming.",
      };
    }
  }
}

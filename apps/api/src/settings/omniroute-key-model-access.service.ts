import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  OmniRouteKeyModelAccessHistory,
  OmniRouteKeyModelAccessOptions,
  OmniRouteKeyModelAccessResult,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { HistoryFile, revertedFromField } from "./history-file.js";
import { REVISION_ID } from "./request-input.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { RoutingManagementBarrier } from "../routing/routing-management-barrier.service.js";
import { RoutingService } from "../routing/routing.service.js";

const safeId = (id: string) => /^[a-zA-Z0-9_.-]{1,100}$/.test(id);
const fail =
  "Modeltoegang niet beschikbaar. Controleer de OmniRoute-koppeling.";
const MAX_HISTORY = 100;
type KeyRow = {
  id: string;
  is_active: number;
  revoked_at: string | null;
  model_access_mode: string | null;
  allowed_models: string | null;
  allowed_connections: string | null;
  allowed_combos: string | null;
  allow_auto_combos: number | null;
};
type KeyModelHistoryRow =
  OmniRouteKeyModelAccessHistory["revisions"][number] & {
    beforeRevision: string;
    afterRevision: string;
  };
const digest = (row: KeyRow) =>
  crypto.createHash("sha256").update(JSON.stringify(row)).digest("hex");
const parseModels = (value: string | null): string[] | null => {
  if (value === null) return null;
  try {
    const parsed: unknown = JSON.parse(value);
    if (
      !Array.isArray(parsed) ||
      parsed.length > 500 ||
      parsed.some((item) => typeof item !== "string" || item.length > 200) ||
      new Set(parsed).size !== parsed.length
    )
      return null;
    return parsed as string[];
  } catch {
    return null;
  }
};

/** Change one non-NOVA key's model allowlist through a fresh, verified gateway write. */
@Injectable()
export class OmniRouteKeyModelAccess {
  private readonly inFlight = new Set<string>();
  private readonly revisions: HistoryFile<KeyModelHistoryRow>;

  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly audit: AuditService,
    private readonly barrier: RoutingManagementBarrier,
    private readonly routing: RoutingService,
  ) {
    this.revisions = new HistoryFile<KeyModelHistoryRow>(
      config.dataFile("omniroute-key-model-access-history.json"),
      (row) => {
        const validModels = (models: unknown) =>
          Array.isArray(models) &&
          models.length <= 100 &&
          models.every(
            (model) =>
              typeof model === "string" &&
              model.length > 0 &&
              model.length <= 200 &&
              !sanitize(model).includes("[redacted]"),
          ) &&
          new Set(models).size === models.length;
        if (
          typeof row.keyId !== "string" ||
          !safeId(row.keyId) ||
          typeof row.name !== "string" ||
          row.name.length > 160 ||
          (row.beforeMode !== "all" && row.beforeMode !== "restricted") ||
          (row.afterMode !== "all" && row.afterMode !== "restricted") ||
          !validModels(row.beforeModels) ||
          !validModels(row.afterModels) ||
          typeof row.beforeRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.beforeRevision) ||
          typeof row.afterRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(row.afterRevision) ||
          (row.revertedFrom !== undefined &&
            (typeof row.revertedFrom !== "string" ||
              !REVISION_ID.test(row.revertedFrom)))
        )
          return undefined;
        return {
          keyId: row.keyId,
          name: String(sanitize(row.name)).slice(0, 160),
          beforeMode: row.beforeMode,
          beforeModels: [...(row.beforeModels as string[])],
          afterMode: row.afterMode,
          afterModels: [...(row.afterModels as string[])],
          beforeRevision: row.beforeRevision,
          afterRevision: row.afterRevision,
          ...revertedFromField(row),
        };
      },
      { max: MAX_HISTORY, durability: "dir" },
    );
  }

  private recordHistory(
    id: string,
    name: string,
    before: KeyRow,
    after: KeyRow,
    revertedFrom?: string,
  ): string | undefined {
    const beforeModels = parseModels(before.allowed_models);
    const afterModels = parseModels(after.allowed_models);
    if (
      (!beforeModels && before.allowed_models !== null) ||
      (!afterModels && after.allowed_models !== null) ||
      (before.model_access_mode !== "all" &&
        before.model_access_mode !== "restricted") ||
      (after.model_access_mode !== "all" &&
        after.model_access_mode !== "restricted")
    )
      return "Modelrechten zijn gewijzigd, maar de geschiedenis kon niet veilig worden vastgelegd.";
    const row: KeyModelHistoryRow = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      keyId: id,
      name: String(sanitize(name)).slice(0, 160),
      beforeMode: before.model_access_mode,
      beforeModels:
        before.model_access_mode === "restricted"
          ? [...(beforeModels ?? [])].sort()
          : [],
      afterMode: after.model_access_mode,
      afterModels:
        after.model_access_mode === "restricted"
          ? [...(afterModels ?? [])].sort()
          : [],
      beforeRevision: digest(before),
      afterRevision: digest(after),
      ...(revertedFrom ? { revertedFrom } : {}),
    };
    try {
      this.revisions.append(row);
      return;
    } catch {
      return "Modelrechten zijn gewijzigd en gecontroleerd, maar de geschiedenis kon niet worden opgeslagen.";
    }
  }

  history(id: string): OmniRouteKeyModelAccessHistory {
    if (!safeId(id)) throw new Error(fail);
    const rows = this.revisions.all().filter((row) => row.keyId === id);
    return {
      revisions: rows
        .slice(-20)
        .reverse()
        .map(({ beforeRevision, afterRevision, ...row }) => {
          void beforeRevision;
          void afterRevision;
          return row;
        }),
      truncated: rows.length >= MAX_HISTORY,
    };
  }

  private row(id: string): KeyRow | undefined {
    if (
      !safeId(id) ||
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error(fail);
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      return db
        .prepare(
          "SELECT id,is_active,revoked_at,model_access_mode,allowed_models,allowed_connections,allowed_combos,allow_auto_combos FROM api_keys WHERE id=?",
        )
        .get(id) as KeyRow | undefined;
    } finally {
      db.close();
    }
  }

  private novaKeyId(): string | undefined {
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      return (
        db
          .prepare("SELECT id FROM api_keys WHERE key=? LIMIT 1")
          .get(this.config.omniKey) as { id?: string } | undefined
      )?.id;
    } finally {
      db.close();
    }
  }

  private async current(id: string) {
    const row = this.row(id);
    if (
      !row ||
      row.is_active !== 1 ||
      row.revoked_at ||
      id === this.novaKeyId()
    )
      throw new Error(fail);
    const raw = await this.management.request("/api/keys");
    const keys =
      raw && typeof raw === "object"
        ? (raw as { keys?: unknown }).keys
        : undefined;
    if (!Array.isArray(keys)) throw new Error(fail);
    const key = keys.find(
      (item) =>
        item &&
        typeof item === "object" &&
        (item as { id?: unknown }).id === id,
    ) as Record<string, unknown> | undefined;
    if (!key || key.isActive !== (row.is_active === 1)) throw new Error(fail);
    const remoteModels = Array.isArray(key.allowedModels)
      ? key.allowedModels
      : key.allowedModels === null || key.allowedModels === undefined
        ? null
        : undefined;
    const localModels = parseModels(row.allowed_models);
    const modelsMatch =
      remoteModels === undefined
        ? false
        : remoteModels === null
          ? row.allowed_models === null
          : localModels !== null &&
            remoteModels.every((item) => typeof item === "string") &&
            JSON.stringify([...remoteModels].sort()) ===
              JSON.stringify([...localModels].sort());
    if (
      (row.model_access_mode !== "all" &&
        row.model_access_mode !== "restricted") ||
      key.modelAccessMode !== row.model_access_mode ||
      (row.allowed_models !== null && !localModels) ||
      remoteModels === undefined ||
      !modelsMatch
    )
      throw new Error(fail);
    return {
      row,
      name:
        typeof key.name === "string"
          ? String(sanitize(key.name)).slice(0, 160)
          : "Sleutel zonder naam",
    };
  }

  private eligibleModels(): string[] {
    const status = this.routing.verifyForManagement();
    if (!status.ready || !status.policyVerified || !status.freeOnly)
      throw new Error(fail);
    return [...new Set(status.enabledModels ?? [])].filter(
      (model) =>
        typeof model === "string" && model.length > 0 && model.length <= 200,
    );
  }

  async options(id: string): Promise<OmniRouteKeyModelAccessOptions> {
    try {
      const models = this.eligibleModels();
      const { row } = await this.current(id);
      const stored = parseModels(row.allowed_models);
      if (row.model_access_mode === "restricted" && !stored)
        throw new Error(fail);
      const allowed = new Set(models);
      return {
        available: true,
        accessMode:
          row.model_access_mode === "restricted" ? "restricted" : "all",
        allowedModels:
          row.model_access_mode === "restricted"
            ? (stored ?? []).filter((item) => allowed.has(item))
            : models,
        verifiedFreeModels: models,
      };
    } catch {
      return {
        available: false,
        error: fail,
        accessMode: "unknown",
        allowedModels: [],
        verifiedFreeModels: [],
      };
    }
  }

  async apply(
    id: string,
    allowedModels: unknown,
  ): Promise<OmniRouteKeyModelAccessResult> {
    if (
      !safeId(id) ||
      !Array.isArray(allowedModels) ||
      allowedModels.length > 100 ||
      allowedModels.some((item) => typeof item !== "string")
    )
      return { ok: false, error: "Controleer de modelkeuze." };
    let selected: string[];
    try {
      const models = this.eligibleModels();
      if (
        new Set(allowedModels).size !== allowedModels.length ||
        allowedModels.length === 0 ||
        allowedModels.some((item) => !models.includes(item as string))
      )
        return {
          ok: false,
          error: "Kies alleen actuele, geverifieerde gratis modellen.",
        };
      selected = [...(allowedModels as string[])].sort();
    } catch {
      return { ok: false, error: fail };
    }
    return this.execute(id, "restricted", selected);
  }

  async rollback(
    id: string,
    revisionId: string,
  ): Promise<OmniRouteKeyModelAccessResult> {
    if (!safeId(id) || !/^[0-9a-f-]{36}$/i.test(revisionId))
      return { ok: false, error: "Ongeldige modelrechtenwijziging." };
    const revisions = this.revisions.all().filter((row) => row.keyId === id);
    const entry = revisions.find((row) => row.id === revisionId);
    if (!entry)
      return {
        ok: false,
        error: "Deze modelrechtenwijziging bestaat niet meer.",
      };
    if (revisions.at(-1)?.id !== entry.id)
      return {
        ok: false,
        error: "Herstel alleen de nieuwste modelrechtenwijziging.",
      };
    return this.execute(
      id,
      entry.beforeMode,
      entry.beforeModels,
      entry.id,
      entry.afterRevision,
    );
  }

  private async execute(
    id: string,
    mode: "restricted" | "all",
    models: string[],
    historyRevision?: string,
    expectedRevision?: string,
  ): Promise<OmniRouteKeyModelAccessResult> {
    if (this.inFlight.has(id))
      return { ok: false, error: "Deze sleutel wordt al gewijzigd." };
    this.inFlight.add(id);
    try {
      return await this.barrier.run(async (operation) => {
        let before: Awaited<ReturnType<OmniRouteKeyModelAccess["current"]>>;
        try {
          const allowedNow =
            mode === "restricted" ? new Set(this.eligibleModels()) : null;
          before = await this.current(id);
          if (expectedRevision && digest(before.row) !== expectedRevision)
            return {
              ok: false,
              error:
                "Modelrechten zijn intussen gewijzigd. Laad de geschiedenis opnieuw.",
            };
          if (allowedNow && models.some((item) => !allowedNow.has(item)))
            return {
              ok: false,
              error:
                "Oudere modellen zijn niet meer toegestaan volgens de gratis route.",
            };
          this.audit.record({
            sessionId: "settings",
            tool: "omniroute_key_model_access",
            risk: "DANGEROUS",
            confirmation: "direct",
            phase: "before_execute",
            arguments: { id, modelCount: models.length, mode },
          });
          operation.block("policy_change");
        } catch {
          return { ok: false, error: fail };
        }
        try {
          await this.management.request(`/api/keys/${id}`, {
            method: "PATCH",
            body: {
              modelAccessMode: mode,
              allowedModels: mode === "restricted" ? models : null,
            },
          });
          const after = await this.current(id);
          const stored = parseModels(after.row.allowed_models);
          if (
            after.row.model_access_mode !== mode ||
            (mode === "restricted" &&
              (!stored ||
                JSON.stringify([...stored].sort()) !==
                  JSON.stringify([...models].sort())))
          )
            throw new Error("permission update not persisted");
          const route = operation.releaseAfterVerification();
          const historyWarning = this.recordHistory(
            id,
            after.name,
            before.row,
            after.row,
            historyRevision,
          );
          const result: OmniRouteKeyModelAccessResult = {
            ok: true,
            verified: true,
            routeReady: route.ready,
            allowedModels:
              mode === "restricted" ? [...(stored ?? [])].sort() : [],
            ...(historyWarning ? { historyWarning } : {}),
          };
          try {
            this.audit.record({
              sessionId: "settings",
              tool: "omniroute_key_model_access",
              risk: "DANGEROUS",
              confirmation: "direct",
              phase: "verified",
              arguments: { id, modelCount: models.length, mode },
              result: { ok: true, routeReady: route.ready },
            });
          } catch {
            return {
              ...result,
              historyWarning:
                "Wijziging gecontroleerd en actief; de laatste auditregel kon niet worden opgeslagen.",
            };
          }
          return result;
        } catch {
          return {
            ok: false,
            verified: null,
            routeReady: false,
            error:
              "Uitkomst niet gecontroleerd. NOVA houdt AI geblokkeerd; controleer OmniRoute-rechten.",
          };
        }
      });
    } catch {
      return { ok: false, error: fail };
    } finally {
      this.inFlight.delete(id);
    }
  }
}

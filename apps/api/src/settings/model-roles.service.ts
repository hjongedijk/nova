import {
  ConflictException,
  Injectable,
  NotFoundException,
} from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import type {
  ModelRoleId,
  ModelRoleHistory,
  ModelRolePreferences,
  ModelRoleRevision,
  ModelRolesSettings,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { RoutingService } from "../routing/routing.service.js";
import { SettingsStore } from "./store/settings.store.js";

const roles: ModelRoleId[] = [
  "conversation",
  "code",
  "planning",
  "summary",
  "vision",
  "embedding",
];
const labels: Record<ModelRoleId, string> = {
  conversation: "Gesprek",
  code: "Code",
  planning: "Denken en plannen",
  summary: "Samenvatten",
  vision: "Beeld",
  embedding: "Inbedden",
};

@Injectable()
export class ModelRolesService {
  lastWarning: string | undefined;
  private readonly historyFile: string;

  constructor(
    private readonly settings: SettingsStore,
    private readonly routing: RoutingService,
    private readonly audit: AuditService,
    config: NovaConfig,
  ) {
    this.historyFile = config.dataFile("model-roles-history.json");
  }

  private eligible(): string[] {
    const status = this.routing.status();
    return status.ready && status.freeOnly && status.policyVerified
      ? [...new Set(status.explicitModels ?? [])].filter(
          (item) => typeof item === "string" && item.length <= 200,
        )
      : [];
  }

  get(): ModelRolesSettings {
    const models = this.eligible();
    const saved = this.settings.get().modelRoles;
    const allowed = new Set(models);
    const normalized = Object.fromEntries(
      roles.map((role) => {
        const preference = saved[role];
        return [
          role,
          {
            preferred: Array.isArray(preference?.preferred)
              ? [...new Set(preference.preferred)].filter((id) =>
                  allowed.has(id),
                )
              : [],
            fallback:
              typeof preference?.fallback === "string" &&
              allowed.has(preference.fallback)
                ? preference.fallback
                : null,
          },
        ];
      }),
    ) as ModelRolePreferences;
    return {
      available: models.length > 0,
      ...(models.length
        ? {}
        : { error: "Er is geen geverifieerde gratis modelkeuze beschikbaar." }),
      verifiedFreeModels: models,
      roles: normalized,
    };
  }

  save(input: unknown): ModelRolesSettings {
    this.lastWarning = undefined;
    const before = this.get().roles;
    const models = this.eligible();
    if (!models.length)
      throw new ValidationError([
        "Modelrollen kunnen niet worden gewijzigd zolang de gratis route niet geverifieerd is.",
      ]);
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new ValidationError(["Ongeldige modelrollen."]);
    const body = input as Record<string, unknown>;
    if (
      Object.keys(body).length !== roles.length ||
      roles.some((role) => !Object.hasOwn(body, role))
    )
      throw new ValidationError(["Alle modelrollen zijn vereist."]);
    const allowed = new Set(models);
    const next = {} as ModelRolePreferences;
    for (const role of roles) {
      const value = body[role];
      if (!value || typeof value !== "object" || Array.isArray(value))
        throw new ValidationError([`Ongeldige rol: ${labels[role]}.`]);
      const row = value as Record<string, unknown>;
      if (
        Object.keys(row).some(
          (key) => !["preferred", "fallback"].includes(key),
        ) ||
        !Array.isArray(row.preferred) ||
        row.preferred.length > 5 ||
        row.preferred.some(
          (id) => typeof id !== "string" || !allowed.has(id),
        ) ||
        new Set(row.preferred).size !== row.preferred.length ||
        (row.fallback !== null &&
          (typeof row.fallback !== "string" ||
            !allowed.has(row.fallback) ||
            row.preferred.includes(row.fallback)))
      )
        throw new ValidationError([
          `Kies voor ${labels[role]} alleen modellen uit de actuele geverifieerde gratis lijst.`,
        ]);
      next[role] = {
        preferred: [...row.preferred] as string[],
        fallback: row.fallback as string | null,
      };
    }
    this.audit.record({
      sessionId: "settings",
      tool: "model_roles_update",
      risk: "SAFE",
      confirmation: "not_required",
      arguments: { roles: roles.length },
    });
    this.settings.update((value) => {
      value.modelRoles = next;
    });
    this.record(before, next);
    return {
      ...this.get(),
      ...(this.lastWarning ? { historyWarning: this.lastWarning } : {}),
    };
  }

  private snapshot(value: unknown): ModelRolePreferences | null {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).length !== roles.length ||
      roles.some((role) => !Object.hasOwn(row, role))
    )
      return null;
    const result = {} as ModelRolePreferences;
    for (const role of roles) {
      const item = row[role];
      if (!item || typeof item !== "object" || Array.isArray(item)) return null;
      const preference = item as Record<string, unknown>;
      if (
        Object.keys(preference).some(
          (key) => !["preferred", "fallback"].includes(key),
        ) ||
        !Array.isArray(preference.preferred) ||
        preference.preferred.length > 5 ||
        preference.preferred.some(
          (id) => typeof id !== "string" || id.length < 1 || id.length > 200,
        ) ||
        new Set(preference.preferred).size !== preference.preferred.length ||
        (preference.fallback !== null &&
          (typeof preference.fallback !== "string" ||
            preference.fallback.length > 200))
      )
        return null;
      result[role] = {
        preferred: [...preference.preferred] as string[],
        fallback: preference.fallback as string | null,
      };
    }
    return result;
  }

  private readHistory(): ModelRoleRevision[] {
    try {
      const value: unknown = JSON.parse(
        fs.readFileSync(this.historyFile, "utf8"),
      );
      if (!Array.isArray(value)) return [];
      return value.flatMap((entry: unknown) => {
        if (!entry || typeof entry !== "object" || Array.isArray(entry))
          return [];
        const row = entry as Record<string, unknown>;
        const before = this.snapshot(row.before);
        const after = this.snapshot(row.after);
        if (
          typeof row.id !== "string" ||
          !/^[0-9a-f-]{36}$/i.test(row.id) ||
          typeof row.at !== "string" ||
          !Number.isFinite(Date.parse(row.at)) ||
          !before ||
          !after
        )
          return [];
        return [
          {
            id: row.id,
            at: new Date(row.at).toISOString(),
            before,
            after,
            ...(typeof row.revertedFrom === "string"
              ? { revertedFrom: row.revertedFrom }
              : {}),
          },
        ];
      });
    } catch {
      return [];
    }
  }

  private writeHistory(entries: ModelRoleRevision[]): void {
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
    const temporary = `${this.historyFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(entries.slice(-100)), {
        mode: 0o600,
      });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.historyFile);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private record(
    before: ModelRolePreferences,
    after: ModelRolePreferences,
    revertedFrom?: string,
  ): void {
    if (isDeepStrictEqual(before, after)) return;
    const revision: ModelRoleRevision = {
      id: crypto.randomUUID(),
      at: new Date().toISOString(),
      before,
      after,
      ...(revertedFrom ? { revertedFrom } : {}),
    };
    try {
      this.writeHistory([...this.readHistory(), revision]);
    } catch {
      this.lastWarning =
        "Modelrollen zijn opgeslagen, maar de wijzigingsgeschiedenis kon niet worden bijgewerkt.";
    }
  }

  history(): ModelRoleHistory {
    const revisions = this.readHistory();
    return {
      revisions: revisions.slice(-50).reverse(),
      truncated: revisions.length > 50,
    };
  }

  rollback(id: string): ModelRolesSettings {
    this.lastWarning = undefined;
    const revision = this.readHistory().find((item) => item.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    const eligible = this.eligible();
    if (!eligible.length)
      throw new ConflictException(
        "De gratis modelroute is niet geverifieerd; herstel is afgebroken.",
      );
    const current = this.get().roles;
    if (!isDeepStrictEqual(current, revision.after))
      throw new ConflictException(
        "Modelrollen zijn daarna gewijzigd. Terugdraaien is afgebroken.",
      );
    const available = new Set(eligible);
    if (
      roles.some(
        (role) =>
          revision.before[role].preferred.some(
            (model) => !available.has(model),
          ) ||
          (revision.before[role].fallback !== null &&
            !available.has(revision.before[role].fallback)),
      )
    )
      throw new ConflictException(
        "Een eerder model is niet meer beschikbaar in de geverifieerde gratis route.",
      );
    this.audit.record({
      sessionId: "settings",
      tool: "model_roles_rollback",
      risk: "SAFE",
      confirmation: "admin_ui",
      arguments: { revision: id },
      phase: "attempt",
    });
    this.settings.update((value) => {
      if (!isDeepStrictEqual(this.get().roles, revision.after))
        throw new ConflictException(
          "Modelrollen zijn intussen gewijzigd. Terugdraaien is afgebroken.",
        );
      value.modelRoles = revision.before;
    });
    this.record(current, revision.before, id);
    try {
      this.audit.record({
        sessionId: "settings",
        tool: "model_roles_rollback",
        risk: "SAFE",
        confirmation: "admin_ui",
        arguments: { revision: id },
        result: { ok: true },
      });
    } catch {
      this.lastWarning =
        "Modelrollen zijn teruggezet, maar de auditmelding kon niet worden geschreven.";
    }
    return {
      ...this.get(),
      ...(this.lastWarning ? { historyWarning: this.lastWarning } : {}),
    };
  }
}

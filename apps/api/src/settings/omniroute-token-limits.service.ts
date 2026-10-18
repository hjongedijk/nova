import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type {
  OmniRouteTokenLimit,
  OmniRouteTokenLimitResult,
  OmniRouteTokenLimitsReport,
  OmniRouteTokenResetInterval,
} from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";
import { object } from "./request-input.js";

const ERROR =
  "Tokenlimieten zijn niet beschikbaar. Controleer de OmniRoute-koppeling.";
const safeId = (value: string) => /^[a-zA-Z0-9_.-]{1,100}$/.test(value);
const isInterval = (value: unknown): value is OmniRouteTokenResetInterval =>
  value === "daily" || value === "weekly" || value === "monthly";
const tokenCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value > 0;
const validClock = (value: unknown): value is string => {
  if (typeof value !== "string" || !/^\d{2}:\d{2}$/.test(value)) return false;
  const [hours, minutes] = value.split(":").map(Number);
  return hours! < 24 && minutes! < 60;
};
const digest = (value: unknown) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");

type KeyRow = { id: string; is_active: number; revoked_at: string | null };
type LimitRow = {
  id: string;
  api_key_id: string;
  scope_type: string;
  scope_value: string;
  token_limit: number;
  reset_interval: string;
  reset_time: string | null;
  enabled: number;
};
type Current = {
  keyName: string;
  keyRow: KeyRow;
  limits: OmniRouteTokenLimit[];
  global: OmniRouteTokenLimit | undefined;
  revision: string;
};

/** Conservative cap management for active, non-NOVA API keys. */
@Injectable()
export class OmniRouteTokenLimits {
  private readonly inFlight = new Set<string>();
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly audit: AuditService,
  ) {}

  private database(): DatabaseSync {
    if (
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured ||
      !this.config.omniKey
    )
      throw new Error(ERROR);
    return new DatabaseSync(this.config.omniDatabase, { readOnly: true });
  }

  private async current(id: string): Promise<Current> {
    if (!safeId(id)) throw new Error(ERROR);
    const db = this.database();
    let keyRow: KeyRow | undefined;
    let rows: LimitRow[];
    let novaKey: string | undefined;
    try {
      keyRow = db
        .prepare("SELECT id,is_active,revoked_at FROM api_keys WHERE id=?")
        .get(id) as KeyRow | undefined;
      novaKey = (
        db
          .prepare("SELECT id FROM api_keys WHERE key=? LIMIT 1")
          .get(this.config.omniKey) as { id?: string } | undefined
      )?.id;
      rows = db
        .prepare(
          "SELECT id,api_key_id,scope_type,scope_value,token_limit,reset_interval,reset_time,enabled FROM api_key_token_limits WHERE api_key_id=?",
        )
        .all(id) as LimitRow[];
    } finally {
      db.close();
    }
    if (
      !keyRow ||
      !novaKey ||
      id === novaKey ||
      keyRow.is_active !== 1 ||
      keyRow.revoked_at !== null
    )
      throw new Error(ERROR);

    const [keysRaw, limitsRaw] = await Promise.all([
      this.management.request("/api/keys"),
      this.management.request(
        `/api/usage/token-limits?apiKeyId=${encodeURIComponent(id)}`,
      ),
    ]);
    const keyList = object(keysRaw);
    const remote = object(limitsRaw);
    if (!Array.isArray(keyList.keys) || !Array.isArray(remote.limits))
      throw new Error(ERROR);
    const key = keyList.keys.map(object).find((entry) => entry.id === id);
    if (!key || key.isActive !== true) throw new Error(ERROR);

    const project = (value: unknown): OmniRouteTokenLimit | undefined => {
      const row = object(value);
      const idValue = row.id;
      const scopeType = row.scopeType;
      const scopeValue = row.scopeValue;
      const tokenLimit = row.tokenLimit;
      const resetInterval = row.resetInterval;
      const resetTime = row.resetTime;
      const enabled = row.enabled;
      if (
        typeof idValue !== "string" ||
        !/^[0-9a-f-]{36}$/i.test(idValue) ||
        (scopeType !== "model" &&
          scopeType !== "provider" &&
          scopeType !== "global") ||
        typeof scopeValue !== "string" ||
        scopeValue.length > 200 ||
        !tokenCount(tokenLimit) ||
        !isInterval(resetInterval) ||
        !validClock(resetTime) ||
        typeof enabled !== "boolean"
      )
        return undefined;
      if (row.apiKeyId !== id) return undefined;
      return {
        id: idValue,
        scopeType,
        scopeValue,
        tokenLimit,
        resetInterval,
        resetTime,
        enabled,
      };
    };
    if (rows.length > 200 || remote.limits.length > 200) throw new Error(ERROR);
    if (rows.some((row) => row.enabled !== 0 && row.enabled !== 1))
      throw new Error(ERROR);
    const stored = rows
      .flatMap((row) => {
        const projected = project({
          id: row.id,
          apiKeyId: row.api_key_id,
          scopeType: row.scope_type,
          scopeValue: row.scope_value,
          tokenLimit: row.token_limit,
          resetInterval: row.reset_interval,
          resetTime: row.reset_time || "00:00",
          enabled: row.enabled === 1,
        });
        return projected ? [projected] : [];
      })
      .sort((a, b) => a.id.localeCompare(b.id));
    const listed = remote.limits
      .flatMap((item: unknown) => {
        const projected = project(item);
        return projected ? [projected] : [];
      })
      .sort((a: OmniRouteTokenLimit, b: OmniRouteTokenLimit) =>
        a.id.localeCompare(b.id),
      );
    if (
      stored.length !== rows.length ||
      listed.length !== remote.limits.length ||
      JSON.stringify(stored) !== JSON.stringify(listed)
    )
      throw new Error(ERROR);
    const global = stored.find(
      (limit) => limit.scopeType === "global" && limit.scopeValue === "",
    );
    if (
      stored.filter(
        (limit) => limit.scopeType === "global" && limit.scopeValue === "",
      ).length > 1
    )
      throw new Error(ERROR);
    const keyName =
      typeof key.name === "string"
        ? String(sanitize(key.name)).slice(0, 160)
        : "Sleutel zonder naam";
    return {
      keyName,
      keyRow,
      limits: stored,
      global,
      revision: digest({ keyRow, limits: stored }),
    };
  }

  async report(id: string): Promise<OmniRouteTokenLimitsReport> {
    try {
      const current = await this.current(id);
      return {
        available: true,
        keyId: id,
        keyName: current.keyName,
        limits: current.limits,
        truncated: false,
      };
    } catch {
      return { available: false, error: ERROR, limits: [], truncated: false };
    }
  }

  async apply(
    id: string,
    rawLimit: unknown,
    rawInterval: unknown,
  ): Promise<OmniRouteTokenLimitResult> {
    if (!safeId(id) || !tokenCount(rawLimit) || !isInterval(rawInterval))
      throw new ValidationError([
        "Vul een positieve tokenlimiet in en kies de periode.",
      ]);
    if (this.inFlight.has(id))
      return {
        ok: false,
        error: "Voor deze sleutel loopt al een limietwijziging.",
      };
    this.inFlight.add(id);
    try {
      const desiredLimit = rawLimit;
      const interval = rawInterval;
      const before = await this.current(id);
      const previousId = before.global?.id ?? null;
      const resetTime = before.global?.resetTime ?? "00:00";
      if (
        before.global &&
        (before.global.resetInterval !== interval ||
          desiredLimit > before.global.tokenLimit ||
          (before.global.enabled && desiredLimit === before.global.tokenLimit))
      )
        return {
          ok: false,
          error:
            "De bestaande limiet kan niet veilig worden verhoogd, herperiodiseerd of herhaald.",
        };
      this.audit.record({
        sessionId: "settings",
        tool: "omniroute_token_limit",
        risk: "DANGEROUS",
        confirmation: "direct",
        phase: "before_execute",
        arguments: {
          keyId: id,
          scopeType: "global",
          oldLimit: before.global?.tokenLimit ?? null,
          tokenLimit: desiredLimit,
          resetInterval: interval,
        },
      });
      const response = object(
        await this.management.request("/api/usage/token-limits", {
          method: "POST",
          body: {
            ...(previousId ? { id: previousId } : {}),
            apiKeyId: id,
            scopeType: "global",
            scopeValue: "",
            tokenLimit: desiredLimit,
            resetInterval: interval,
            resetTime,
            enabled: true,
          },
        }),
      );
      if (response.success !== true) throw new Error(ERROR);
      const after = await this.current(id);
      const limit = after.global;
      if (
        !limit ||
        limit.tokenLimit !== desiredLimit ||
        !limit.enabled ||
        limit.resetInterval !== interval ||
        limit.resetTime !== resetTime ||
        after.limits.filter((entry) => entry.scopeType !== "global").length !==
          before.limits.filter((entry) => entry.scopeType !== "global").length
      )
        throw new Error(ERROR);
      let auditWarning: string | undefined;
      try {
        this.audit.record({
          sessionId: "settings",
          tool: "omniroute_token_limit",
          risk: "DANGEROUS",
          confirmation: "direct",
          phase: "after_execute",
          arguments: {
            keyId: id,
            scopeType: "global",
            tokenLimit: desiredLimit,
            resetInterval: interval,
          },
          result: { ok: true },
          verification: { persisted: true },
        });
      } catch {
        auditWarning =
          "De wijziging is gecontroleerd, maar kon niet volledig in het actielog worden vastgelegd.";
      }
      return {
        ok: true,
        verified: true,
        ...(auditWarning ? { auditWarning } : {}),
      };
    } catch {
      return {
        ok: false,
        verified: null,
        error:
          "Limietwijziging niet bevestigd. Controleer de tokenlimiet in OmniRoute.",
      };
    } finally {
      this.inFlight.delete(id);
    }
  }
}

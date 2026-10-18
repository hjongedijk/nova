import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { DatabaseSync } from "node:sqlite";
import type { NativePromptResult } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";

type Prompt = { enabled: boolean; prefixPrompt: string; suffixPrompt: string };
type PromptRevision = { id: string; at: string; before: Prompt; after: Prompt };
const MAX_PROMPT_REVISIONS = 20;
const error =
  "Promptbeheer is niet beschikbaar. Controleer de OmniRoute-koppeling.";

/** Full replacements only. Prompt contents never enter audit arguments. */
@Injectable()
export class NativePromptService {
  private readonly historyFile: string;
  private inFlight = false;
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly audit: AuditService,
  ) {
    this.historyFile = config.dataFile("native-prompt-history.json");
  }

  private safePrompt(value: unknown): Prompt | null {
    if (!value || typeof value !== "object" || Array.isArray(value))
      return null;
    const row = value as Record<string, unknown>;
    if (
      Object.keys(row).some(
        (key) => !["enabled", "prefixPrompt", "suffixPrompt"].includes(key),
      ) ||
      typeof row.enabled !== "boolean" ||
      typeof row.prefixPrompt !== "string" ||
      typeof row.suffixPrompt !== "string" ||
      row.prefixPrompt.length > 50000 ||
      row.suffixPrompt.length > 50000
    )
      return null;
    const prompt = {
      enabled: row.enabled,
      prefixPrompt: row.prefixPrompt,
      suffixPrompt: row.suffixPrompt,
    };
    return JSON.stringify(sanitize(prompt)) === JSON.stringify(prompt)
      ? prompt
      : null;
  }

  private revisions(): PromptRevision[] {
    try {
      const rows: unknown = JSON.parse(
        fs.readFileSync(this.historyFile, "utf8"),
      );
      if (!Array.isArray(rows)) return [];
      return rows
        .flatMap((value: unknown) => {
          if (!value || typeof value !== "object" || Array.isArray(value))
            return [];
          const row = value as Record<string, unknown>;
          const before = this.safePrompt(row.before);
          const after = this.safePrompt(row.after);
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
            { id: row.id, at: new Date(row.at).toISOString(), before, after },
          ];
        })
        .slice(-MAX_PROMPT_REVISIONS);
    } catch {
      return [];
    }
  }

  history(): { revisions: PromptRevision[]; truncated: boolean } {
    const rows = this.revisions();
    return {
      revisions: rows.reverse(),
      truncated: rows.length === MAX_PROMPT_REVISIONS,
    };
  }

  private recordHistory(before: unknown, after: unknown): void {
    const safeBefore = this.safePrompt(before);
    const safeAfter = this.safePrompt(after);
    if (
      !safeBefore ||
      !safeAfter ||
      JSON.stringify(safeBefore) === JSON.stringify(safeAfter)
    )
      return;
    const rows = [
      ...this.revisions(),
      {
        id: crypto.randomUUID(),
        at: new Date().toISOString(),
        before: safeBefore,
        after: safeAfter,
      },
    ].slice(-MAX_PROMPT_REVISIONS);
    fs.mkdirSync(path.dirname(this.historyFile), { recursive: true });
    const temporary = `${this.historyFile}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temporary, JSON.stringify(rows), { mode: 0o600 });
      fs.chmodSync(temporary, 0o600);
      fs.renameSync(temporary, this.historyFile);
    } finally {
      fs.rmSync(temporary, { force: true });
    }
  }

  private stored(): string | undefined {
    if (
      this.config.omniUrl !== this.config.verifiedOmniUrl ||
      !this.management.configured
    )
      throw new Error(error);
    const db = new DatabaseSync(this.config.omniDatabase, { readOnly: true });
    try {
      return (
        db
          .prepare(
            "SELECT value FROM key_value WHERE namespace='settings' AND key='systemPrompt'",
          )
          .get() as { value: string } | undefined
      )?.value;
    } finally {
      db.close();
    }
  }

  /** Replaces the gateway system prompt immediately. */
  async replace(value: unknown): Promise<NativePromptResult> {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ValidationError(["Ongeldige promptwijziging."]);
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) => !["enabled", "prefixPrompt", "suffixPrompt"].includes(key),
      ) ||
      typeof input.enabled !== "boolean"
    )
      throw new ValidationError(["Ongeldige promptwijziging."]);
    for (const key of ["prefixPrompt", "suffixPrompt"] as const) {
      if (typeof input[key] !== "string" || input[key].length > 50000)
        throw new ValidationError([
          "Elk promptveld mag maximaal 50.000 tekens bevatten.",
        ]);
      if (sanitize(input[key]) !== input[key])
        throw new ValidationError([
          "Plaats geen geheimen of wachtwoorden in een prompt.",
        ]);
    }
    const prompt: Prompt = {
      enabled: input.enabled,
      prefixPrompt: input.prefixPrompt as string,
      suffixPrompt: input.suffixPrompt as string,
    };
    const metadata = {
      enabled: prompt.enabled,
      prefixCharacters: prompt.prefixPrompt.length,
      suffixCharacters: prompt.suffixPrompt.length,
    };
    if (this.inFlight)
      return {
        ok: false,
        error:
          "De gateway-prompt wordt al gewijzigd. Probeer opnieuw zodra die klaar is.",
      };
    this.inFlight = true;
    try {
      let previousPrompt: Prompt | null = null;
      try {
        const current = this.stored();
        try {
          previousPrompt = this.safePrompt(JSON.parse(current ?? "null"));
        } catch {
          previousPrompt = null;
        }
        this.audit.record({
          sessionId: "settings",
          tool: "native_prompt_replace",
          risk: "DANGEROUS",
          confirmation: "direct",
          phase: "before_execute",
          arguments: metadata,
        });
      } catch {
        return { ok: false, error };
      }
      try {
        await this.management.request("/api/settings/system-prompt", {
          method: "PUT",
          body: prompt,
        });
        const stored = this.safePrompt(
          JSON.parse(this.stored() ?? "null") as unknown,
        );
        if (
          !stored ||
          Object.keys(stored).length !== 3 ||
          stored.enabled !== prompt.enabled ||
          stored.prefixPrompt !== prompt.prefixPrompt ||
          stored.suffixPrompt !== prompt.suffixPrompt
        )
          throw new Error("Persistence not verified");
        const runtime = await this.management.request<Prompt>(
          "/api/settings/system-prompt",
        );
        if (
          !runtime ||
          runtime.enabled !== prompt.enabled ||
          runtime.prefixPrompt !== prompt.prefixPrompt ||
          runtime.suffixPrompt !== prompt.suffixPrompt
        )
          throw new Error("Runtime not verified");
        try {
          this.recordHistory(previousPrompt, prompt);
        } catch {
          /* History must not invalidate a verified gateway update. */
        }
        const result: NativePromptResult = { ok: true, verified: true };
        try {
          this.audit.record({
            sessionId: "settings",
            tool: "native_prompt_replace",
            risk: "DANGEROUS",
            confirmation: "direct",
            phase: "after_execute",
            arguments: metadata,
            result: { ok: true },
            verification: { persisted: true, runtime: true },
          });
        } catch {
          result.auditWarning =
            "Opgeslagen en gecontroleerd; de afronding kon niet in het actielog worden geschreven.";
        }
        return result;
      } catch {
        try {
          this.audit.record({
            sessionId: "settings",
            tool: "native_prompt_replace",
            risk: "DANGEROUS",
            confirmation: "direct",
            phase: "after_execute",
            arguments: metadata,
            result: { ok: false },
            verification: { persisted: null, runtime: null },
          });
        } catch {
          /* Pre-write audit remains available. */
        }
        return {
          ok: false,
          verified: null,
          error:
            "De promptwijziging kon niet volledig worden gecontroleerd. De gateway kan al gewijzigd zijn; controleer de status.",
        };
      }
    } finally {
      this.inFlight = false;
    }
  }
}

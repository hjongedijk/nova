import { Injectable, type OnModuleDestroy } from "@nestjs/common";
import crypto from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { NativePromptPrepared, NativePromptResult } from "@nova/contracts";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { AuditService } from "../core/audit/audit.service.js";
import { NovaConfig } from "../core/config/nova-config.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { OmniRouteManagement } from "../routing/omniroute-management.service.js";

type Prompt = { enabled: boolean; prefixPrompt: string; suffixPrompt: string };
type Draft = {
  sessionId: string;
  expiresAt: number;
  revision: string;
  prompt: Prompt;
};
const digest = (value: string | undefined) =>
  crypto
    .createHash("sha256")
    .update(value === undefined ? "missing" : `value:${value}`)
    .digest("hex");
const error =
  "Promptbeheer is niet beschikbaar. Controleer de OmniRoute-koppeling.";

/** Full replacements only. Neither existing prompt contents nor private drafts enter confirmation args. */
@Injectable()
export class NativePromptService implements OnModuleDestroy {
  private readonly drafts = new Map<string, Draft>();
  private readonly expiryTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();
  private inFlight = false;
  private drop(id: string): void {
    this.drafts.delete(id);
    clearTimeout(this.expiryTimers.get(id));
    this.expiryTimers.delete(id);
  }
  onModuleDestroy(): void {
    for (const id of this.drafts.keys()) this.drop(id);
  }
  constructor(
    private readonly config: NovaConfig,
    private readonly management: OmniRouteManagement,
    private readonly confirmations: ConfirmationsService,
    private readonly audit: AuditService,
  ) {}

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

  prepare(value: unknown): NativePromptPrepared {
    if (!value || typeof value !== "object" || Array.isArray(value))
      throw new ValidationError(["Ongeldige promptwijziging."]);
    const input = value as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) =>
          ![
            "enabled",
            "prefixPrompt",
            "suffixPrompt",
            "acknowledgeGlobal",
          ].includes(key),
      ) ||
      typeof input.enabled !== "boolean" ||
      input.acknowledgeGlobal !== true
    )
      throw new ValidationError([
        "Bevestig dat je beide promptvelden voor alle gateway-clients vervangt.",
      ]);
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
    for (const [id, draft] of this.drafts) {
      const pending = this.confirmations.peek(draft.sessionId);
      if (
        !pending ||
        pending.confirmationId !== id ||
        pending.expiresAt <= Date.now()
      )
        this.drop(id);
    }
    if (this.drafts.size >= 20)
      return {
        ok: false,
        error:
          "Er staan te veel promptwijzigingen open. Annuleer ze of wacht één minuut.",
      };
    try {
      const revision = digest(this.stored());
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
      this.audit.record({
        sessionId: "settings",
        tool: "native_prompt_replace",
        risk: "DANGEROUS",
        confirmation: "pending_admin_ui",
        arguments: metadata,
      });
      const action = this.confirmations.create(
        `settings-prompt:${crypto.randomUUID()}`,
        "native_prompt_replace",
        metadata,
        "DANGEROUS",
        undefined,
        false,
      );
      this.drafts.set(action.confirmationId, {
        sessionId: action.sessionId,
        expiresAt: action.expiresAt,
        revision,
        prompt,
      });
      const id = action.confirmationId;
      const timer = setTimeout(
        () => this.drop(id),
        Math.max(0, action.expiresAt - Date.now()),
      );
      timer.unref();
      this.expiryTimers.set(id, timer);
      return { ok: true, action };
    } catch {
      return { ok: false, error };
    }
  }

  async confirm(
    sessionId: string,
    confirmationId: string,
    approve: boolean,
  ): Promise<NativePromptResult> {
    if (
      !/^settings-prompt:[0-9a-f-]{36}$/i.test(sessionId) ||
      !/^[0-9a-f-]{36}$/i.test(confirmationId)
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    const draft = this.drafts.get(confirmationId);
    const pending = this.confirmations.peek(sessionId);
    if (
      !draft ||
      draft.sessionId !== sessionId ||
      !pending ||
      pending.confirmationId !== confirmationId ||
      pending.tool !== "native_prompt_replace"
    )
      return {
        ok: false,
        error:
          "Deze bevestiging staat niet meer open. Bereid de wijziging opnieuw voor.",
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
        error: "Bevestiging verlopen. Bereid de wijziging opnieuw voor.",
      };
    if (this.inFlight)
      return {
        ok: false,
        error:
          "De gateway-prompt wordt al gewijzigd. Probeer opnieuw zodra die klaar is.",
      };
    this.inFlight = true;
    try {
      try {
        if (digest(this.stored()) !== draft.revision)
          return {
            ok: false,
            error:
              "De gateway-prompt is ondertussen gewijzigd. Bereid de wijziging opnieuw voor.",
          };
        this.audit.record({
          sessionId: "settings",
          tool: "native_prompt_replace",
          risk: "DANGEROUS",
          confirmation: "confirmed_admin_ui",
          phase: "before_execute",
          arguments: action.args,
        });
      } catch {
        return { ok: false, error };
      }
      try {
        await this.management.request("/api/settings/system-prompt", {
          method: "PUT",
          body: draft.prompt,
        });
        const stored = JSON.parse(this.stored() ?? "null") as Prompt | null;
        if (
          !stored ||
          Object.keys(stored).length !== 3 ||
          stored.enabled !== draft.prompt.enabled ||
          stored.prefixPrompt !== draft.prompt.prefixPrompt ||
          stored.suffixPrompt !== draft.prompt.suffixPrompt
        )
          throw new Error("Persistence not verified");
        const runtime = await this.management.request<Prompt>(
          "/api/settings/system-prompt",
        );
        if (
          !runtime ||
          runtime.enabled !== draft.prompt.enabled ||
          runtime.prefixPrompt !== draft.prompt.prefixPrompt ||
          runtime.suffixPrompt !== draft.prompt.suffixPrompt
        )
          throw new Error("Runtime not verified");
        const result: NativePromptResult = { ok: true, verified: true };
        try {
          this.audit.record({
            sessionId: "settings",
            tool: "native_prompt_replace",
            risk: "DANGEROUS",
            confirmation: "confirmed_admin_ui",
            phase: "after_execute",
            arguments: action.args,
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
            confirmation: "confirmed_admin_ui",
            phase: "after_execute",
            arguments: action.args,
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

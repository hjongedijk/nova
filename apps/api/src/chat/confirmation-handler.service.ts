import { Injectable } from "@nestjs/common";
import type { PendingConfirmation } from "@nova/contracts";
import { AuditService } from "../core/audit/audit.service.js";
import { ConfirmationsService } from "../confirmations/confirmations.service.js";
import { confirmationIntent } from "../confirmations/confirmation-words.js";
import { SessionMemoryService } from "../memory/session-memory.service.js";
import { ToolsService } from "../tools/tools.service.js";
import type { ToolResult } from "../tools/tool.types.js";
import { hasOutput, OutcomeService } from "./outcome.service.js";

export interface DirectReply {
  reply: string;
  result?: ToolResult;
}

const NOTHING_OPEN =
  "Daar staat niets meer voor open. Vraag het gerust opnieuw.";
const NOTHING_OPEN_EN =
  "There is nothing waiting for confirmation. Please ask again.";

/**
 * Turns "ja", "nee" and the interface's confirm buttons into the approved or cancelled action.
 * A plain "ja" with nothing waiting is just conversation, so it goes on to the model.
 */
@Injectable()
export class ConfirmationHandler {
  constructor(
    private readonly confirmations: ConfirmationsService,
    private readonly tools: ToolsService,
    private readonly audit: AuditService,
    private readonly memory: SessionMemoryService,
    private readonly outcome: OutcomeService,
  ) {}

  /** Null when the message is not an answer to a confirmation. */
  async handle(
    sessionId: string,
    message: string,
    confirmationId?: string,
    always = false,
    language: "nl" | "en" = "nl",
  ): Promise<DirectReply | null> {
    const intent = confirmationIntent(message);
    if (!intent) return null;
    if (!confirmationId && !this.confirmations.has(sessionId)) return null;

    if (intent === "cancel") {
      if (
        confirmationId &&
        this.confirmations.peek(sessionId)?.confirmationId !== confirmationId
      )
        return { reply: language === "en" ? NOTHING_OPEN_EN : NOTHING_OPEN };
      const pending = this.confirmations.peek(sessionId);
      if (pending)
        this.audit.record({
          sessionId,
          tool: pending.tool,
          risk: pending.risk,
          confirmation: "rejected",
          arguments: pending.args,
        });
      this.confirmations.cancel(sessionId);
      return {
        reply:
          language === "en"
            ? "Okay, I will leave it."
            : "Oké, ik laat het zitten.",
      };
    }

    const action = this.confirmations.take(sessionId, confirmationId);
    if (!action)
      return { reply: language === "en" ? NOTHING_OPEN_EN : NOTHING_OPEN };
    return this.run(sessionId, action, always, language);
  }

  private async run(
    sessionId: string,
    action: PendingConfirmation,
    always = false,
    language: "nl" | "en" = "nl",
  ): Promise<DirectReply> {
    const result = await this.tools.execute(
      action.tool,
      action.args,
      sessionId,
      action,
      always,
    );
    if (result.requiresConfirmation && result.action) {
      if (
        this.confirmations.peek(sessionId)?.confirmationId ===
        result.action.confirmationId
      )
        this.confirmations.cancel(sessionId, "confirmation_changed");
      const reply =
        language === "en"
          ? "The settings changed, so I did not run the action. Please ask again to review and confirm the current change."
          : "De instellingen zijn gewijzigd. Ik heb niets uitgevoerd. Vraag het opnieuw, dan kun je de actuele wijziging bevestigen.";
      const failed = { ...result, ok: false, error: reply };
      delete failed.requiresConfirmation;
      delete failed.action;
      return { reply, result: failed };
    }
    // Something to read came back (command output): say what it was, not just that it is done.
    if (result.ok && hasOutput(result))
      return {
        reply: await this.outcome.describe({
          action,
          result,
          history: this.memory.recent(sessionId, 4),
          language,
        }),
        result,
      };
    return {
      reply:
        language === "en"
          ? result.verified === true
            ? "Done, and I verified it."
            : result.accepted
              ? "Accepted, but I could not verify that it completed."
              : result.ok
                ? "Done."
                : `That did not work${result.error ? `: ${result.error}` : "."}`
          : result.verified === true
            ? "Gelukt, en ik heb het gecontroleerd."
            : result.accepted
              ? "Aangenomen, maar of het echt gelukt is weet ik nog niet."
              : result.ok
                ? "Is gedaan."
                : `Dat is niet gelukt${result.error ? `: ${result.error}` : "."}`,
      result,
    };
  }
}

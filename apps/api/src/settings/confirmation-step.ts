import type { PendingConfirmation } from "@nova/contracts";
import type { ConfirmationsService } from "../confirmations/confirmations.service.js";

export type ConfirmationReply = { ok: true } | { ok: false; error: string };

export interface ConfirmationClaim {
  /** The tool the confirmation was prepared for. */
  tool: string;
  /** Argument that must equal the target of the request (usually `id`). */
  arg?: { name: string; value: unknown };
  /** Reply when no matching confirmation is open any more. */
  stale: string;
  /** Reply when the confirmation expired between peek and take. */
  expired: string;
  /** Reply when the admin rejects (default `{ ok: true }`). */
  cancelled?: { ok: true } & Record<string, unknown>;
}

/**
 * Shared opening of every settings confirm step: checks the pending confirmation
 * belongs to this request, handles rejection, and consumes it exactly once.
 * Returns the action to execute, or the reply to send straight back.
 */
export function claimConfirmation(
  confirmations: ConfirmationsService,
  sessionId: string,
  confirmationId: string,
  approve: boolean,
  claim: ConfirmationClaim,
): { action: PendingConfirmation } | { reply: ConfirmationReply } {
  const pending = confirmations.peek(sessionId);
  if (
    !pending ||
    pending.tool !== claim.tool ||
    (claim.arg && pending.args[claim.arg.name] !== claim.arg.value) ||
    pending.confirmationId !== confirmationId
  )
    return { reply: { ok: false, error: claim.stale } };
  if (!approve) {
    confirmations.cancel(sessionId, "rejected_admin_ui");
    return { reply: claim.cancelled ?? { ok: true } };
  }
  const action = confirmations.take(sessionId, confirmationId);
  if (!action) return { reply: { ok: false, error: claim.expired } };
  return { action };
}

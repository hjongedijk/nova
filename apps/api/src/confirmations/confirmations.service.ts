import { Injectable, Logger } from "@nestjs/common";
import type { PendingConfirmation, Risk } from "@nova/contracts";
import crypto from "node:crypto";
import { AuditService } from "../core/audit/audit.service.js";

/**
 * Actions waiting for the user's "ja": one per session, valid for 60 seconds, used once.
 * Every expiry and cancellation is written to the action log.
 */
@Injectable()
export class ConfirmationsService {
  readonly ttlMs = 60_000;
  private readonly pending = new Map<string, PendingConfirmation>();
  private readonly log = new Logger("CONFIRM");
  /** Replaceable in tests. */
  now: () => number = Date.now;

  constructor(private readonly audit: AuditService) {}

  create(
    sessionId: string,
    tool: string,
    args: Record<string, unknown>,
    risk?: Risk,
  ): PendingConfirmation {
    const now = this.now();
    for (const [id, action] of this.pending)
      if (action.expiresAt <= now) {
        this.audit.record({
          sessionId: id,
          tool: action.tool,
          risk: action.risk,
          confirmation: "expired",
        });
        this.pending.delete(id);
      }
    const action: PendingConfirmation = {
      confirmationId: crypto.randomUUID(),
      sessionId,
      tool,
      args: structuredClone(args),
      risk,
      createdAt: now,
      expiresAt: now + this.ttlMs,
    };
    this.pending.set(sessionId, action);
    this.log.log(`pending ${tool}`);
    return structuredClone(action);
  }

  has(sessionId: string): boolean {
    return this.pending.has(sessionId);
  }

  peek(sessionId: string): PendingConfirmation | undefined {
    const action = this.pending.get(sessionId);
    return action && structuredClone(action);
  }

  /** The pending action, if it is still valid and (when given) has this id. It is used up. */
  take(sessionId: string, id?: string): PendingConfirmation | null {
    const action = this.pending.get(sessionId);
    if (!action || (id && id !== action.confirmationId)) return null;
    this.pending.delete(sessionId);
    if (action.expiresAt <= this.now()) {
      this.audit.record({
        sessionId,
        tool: action.tool,
        risk: action.risk,
        confirmation: "expired",
      });
      return null;
    }
    this.log.log(`approved ${action.tool}`);
    return action;
  }

  cancel(sessionId: string, reason = "cancelled"): boolean {
    const action = this.pending.get(sessionId);
    if (action)
      this.audit.record({
        sessionId,
        tool: action.tool,
        risk: action.risk,
        arguments: action.args,
        confirmation: reason,
      });
    return this.pending.delete(sessionId);
  }
}

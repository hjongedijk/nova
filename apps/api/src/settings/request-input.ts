import crypto from "node:crypto";
import { ValidationError } from "../core/errors/validation.error.js";

/** Shared request/input helpers for the settings controllers and services. */

export const object = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};

/** A plain JSON object body that contains no keys outside `keys`. */
export function strictBody(
  body: unknown,
  keys: string[],
  message: string,
): Record<string, unknown> {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !keys.includes(key))
  )
    throw new ValidationError([message]);
  return body as Record<string, unknown>;
}

export interface ConfirmationInput {
  sessionId: string;
  confirmationId: string;
  approve: boolean;
}

/** The body of every prepare/confirm flow's confirm step. */
export function assertConfirmation(
  value: Record<string, unknown>,
): asserts value is Record<string, unknown> & ConfirmationInput {
  if (
    typeof value.sessionId !== "string" ||
    typeof value.confirmationId !== "string" ||
    typeof value.approve !== "boolean"
  )
    throw new ValidationError(["Ongeldige bevestiging."]);
}

export const REVISION_ID = /^[0-9a-f-]{36}$/i;

/** Constant-time comparison that hides the secrets' lengths. */
export const sameSecret = (left: string, right: string) =>
  crypto.timingSafeEqual(
    crypto.createHash("sha256").update(left).digest(),
    crypto.createHash("sha256").update(right).digest(),
  );

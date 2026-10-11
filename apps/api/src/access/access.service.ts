import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { NovaConfig } from "../core/config/nova-config.js";

const COOKIE = "nova_access";
const SESSION_TTL_MS = 12 * 60 * 60 * 1000;
const FAILURE_WINDOW_MS = 5 * 60 * 1000;
const MAX_FAILURES = 5;
const MAX_CLIENTS = 1000;
const MAX_SESSIONS = 1000;

type FailureState = { count: number; until: number; blockedUntil: number };

function same(leftValue: unknown, rightValue: string): boolean {
  const left = Buffer.from(String(leftValue ?? ""));
  const right = Buffer.from(rightValue);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

function cookieValue(request: Request): string {
  const cookieHeader = request.headers.cookie ?? "";
  for (const part of cookieHeader.split(";")) {
    const split = part.indexOf("=");
    if (split < 0 || part.slice(0, split).trim() !== COOKIE) continue;
    try {
      return decodeURIComponent(part.slice(split + 1).trim());
    } catch {
      return "";
    }
  }
  return "";
}

@Injectable()
export class AppAccessService {
  private readonly sessions = new Map<string, number>();
  private readonly failures = new Map<string, FailureState>();

  constructor(private readonly config: NovaConfig) {}

  get required(): boolean {
    return this.config.appToken.length > 0;
  }

  isAuthorized(request: Request): boolean {
    if (!this.required) return true;
    const value = cookieValue(request);
    if (!value) return false;
    const key = crypto.createHash("sha256").update(value).digest("hex");
    const expiresAt = this.sessions.get(key);
    if (!expiresAt) return false;
    if (expiresAt <= Date.now()) {
      this.sessions.delete(key);
      return false;
    }
    return true;
  }

  status(request: Request): { required: boolean; unlocked: boolean } {
    return {
      required: this.required,
      unlocked: this.isAuthorized(request),
    };
  }

  unlock(token: unknown, request: Request, response: Response): void {
    if (!this.required) return;
    const now = Date.now();
    const client = request.ip || request.socket.remoteAddress || "unknown";
    let state = this.failures.get(client);
    if (state?.blockedUntil && state.blockedUntil > now)
      this.reject("Te veel onjuiste toegangscodes. Probeer later opnieuw.");

    if (
      typeof token !== "string" ||
      token.length > 512 ||
      !same(token, this.config.appToken)
    ) {
      if (!state || state.until <= now) {
        for (const [key, entry] of this.failures) {
          if (Math.max(entry.until, entry.blockedUntil) <= now)
            this.failures.delete(key);
        }
        if (!this.failures.has(client) && this.failures.size >= MAX_CLIENTS) {
          const oldest = this.failures.keys().next().value;
          if (oldest !== undefined) this.failures.delete(oldest);
        }
        state = { count: 0, until: now + FAILURE_WINDOW_MS, blockedUntil: 0 };
        this.failures.set(client, state);
      }
      state.count += 1;
      if (state.count >= MAX_FAILURES)
        state.blockedUntil = now + FAILURE_WINDOW_MS;
      this.reject(
        state.blockedUntil
          ? "Te veel onjuiste toegangscodes. Probeer later opnieuw."
          : "Toegangscode onjuist.",
      );
    }

    this.failures.delete(client);
    const value = crypto.randomBytes(32).toString("base64url");
    const key = crypto.createHash("sha256").update(value).digest("hex");
    const expiresAt = now + SESSION_TTL_MS;
    this.sessions.set(key, expiresAt);
    for (const [session, expiry] of this.sessions) {
      if (expiry <= now) this.sessions.delete(session);
    }
    if (this.sessions.size > MAX_SESSIONS) {
      const oldest = this.sessions.keys().next().value;
      if (oldest !== undefined) this.sessions.delete(oldest);
    }
    response.cookie(COOKIE, value, {
      httpOnly: true,
      secure: true,
      sameSite: "strict",
      path: "/api",
      maxAge: SESSION_TTL_MS,
    });
  }

  private reject(message: string): never {
    // Keep a uniform public response; do not reveal whether a configured token exists.
    const error = new Error(message) as Error & { status?: number };
    error.status = message.startsWith("Te veel") ? 429 : 401;
    throw error;
  }
}

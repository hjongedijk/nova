import {
  type CanActivate,
  type ExecutionContext,
  ForbiddenException,
  Injectable,
  SetMetadata,
} from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import crypto from "node:crypto";
import type { Request, Response } from "express";
import { NovaConfig } from "../core/config/nova-config.js";

const PUBLIC = "nova:settings-public";
const PIN_WINDOW_MS = 5 * 60 * 1000;
const MAX_PIN_ATTEMPTS = 5;
const MAX_PIN_CLIENTS = 1000;

type PinAttempts = {
  failures: number;
  expiresAt: number;
  blockedUntil: number;
};

/** Marks a settings route that needs neither the PIN nor the admin header. */
export const PublicRoute = () => SetMetadata(PUBLIC, true);

const same = (a: unknown, b: unknown): boolean => {
  const left = Buffer.from(String(a ?? ""));
  const right = Buffer.from(String(b ?? ""));
  return left.length === right.length && crypto.timingSafeEqual(left, right);
};

/**
 * The settings API is for the settings screen only. With NOVA_ADMIN_PIN set, every route needs
 * the PIN (x-nova-pin); every write needs a header a plain cross-site form cannot send
 * (x-nova-admin: 1). The public list is open, because the home screen needs it.
 */
@Injectable()
export class SettingsGuard implements CanActivate {
  private readonly pinAttempts = new Map<string, PinAttempts>();

  private block(response: Response, until: number, now: number): never {
    const retryAfterSeconds = Math.max(1, Math.ceil((until - now) / 1000));
    response.setHeader("Retry-After", String(retryAfterSeconds));
    response.status(429).json({
      error: "Te veel onjuiste PIN-pogingen. Probeer later opnieuw.",
      pinRequired: true,
      retryAfterSeconds,
    });
    throw new ForbiddenException("Te veel PIN-pogingen");
  }

  private rememberFailure(client: string, now: number): PinAttempts {
    let attempts = this.pinAttempts.get(client);
    if (!attempts || attempts.expiresAt <= now) {
      for (const [key, entry] of this.pinAttempts) {
        if (Math.max(entry.expiresAt, entry.blockedUntil) <= now)
          this.pinAttempts.delete(key);
      }
      if (
        !this.pinAttempts.has(client) &&
        this.pinAttempts.size >= MAX_PIN_CLIENTS
      ) {
        const oldest = this.pinAttempts.keys().next().value;
        if (oldest !== undefined) this.pinAttempts.delete(oldest);
      }
      attempts = {
        failures: 0,
        expiresAt: now + PIN_WINDOW_MS,
        blockedUntil: 0,
      };
      this.pinAttempts.set(client, attempts);
    }
    attempts.failures += 1;
    if (attempts.failures >= MAX_PIN_ATTEMPTS)
      attempts.blockedUntil = now + PIN_WINDOW_MS;
    return attempts;
  }

  constructor(
    private readonly config: NovaConfig,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: ExecutionContext): boolean {
    if (this.reflector.get<boolean>(PUBLIC, context.getHandler())) return true;
    const http = context.switchToHttp();
    const request = http.getRequest<Request>();
    const response = http.getResponse<Response>();
    const pin = this.config.adminPin;
    if (pin) {
      const now = Date.now();
      const client = request.ip || request.socket?.remoteAddress || "unknown";
      const attempts = this.pinAttempts.get(client);
      if (attempts && attempts.blockedUntil > now)
        this.block(response, attempts.blockedUntil, now);
      const supplied = request.get("x-nova-pin");
      if (!same(supplied, pin)) {
        // Loading the locked screen without a PIN is not a guessed PIN.
        if (supplied !== undefined && supplied !== "") {
          const failed = this.rememberFailure(client, now);
          if (failed.blockedUntil > now)
            this.block(response, failed.blockedUntil, now);
        }
        // The error filter only passes on a message; this answer also tells the screen to ask for the PIN.
        response.status(401).json({ error: "PIN vereist", pinRequired: true });
        throw new ForbiddenException("PIN vereist");
      }
      this.pinAttempts.delete(client);
    }
    if (request.method !== "GET" && request.get("x-nova-admin") !== "1")
      throw new ForbiddenException("Alleen via het instellingenscherm.");
    return true;
  }
}

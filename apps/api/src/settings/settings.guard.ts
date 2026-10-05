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
    if (pin && !same(request.get("x-nova-pin"), pin)) {
      // The error filter only passes on a message; this answer also tells the screen to ask for the PIN.
      response.status(401).json({ error: "PIN vereist", pinRequired: true });
      throw new ForbiddenException("PIN vereist");
    }
    if (request.method !== "GET" && request.get("x-nova-admin") !== "1")
      throw new ForbiddenException("Alleen via het instellingenscherm.");
    return true;
  }
}

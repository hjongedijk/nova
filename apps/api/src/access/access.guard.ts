import { CanActivate, ForbiddenException, Injectable } from "@nestjs/common";
import { Reflector } from "@nestjs/core";
import type { Request } from "express";
import { AppAccessService } from "./access.service.js";
import { APP_ACCESS_PUBLIC } from "./access-public.js";

@Injectable()
export class AppAccessGuard implements CanActivate {
  constructor(
    private readonly access: AppAccessService,
    private readonly reflector: Reflector,
  ) {}

  canActivate(context: import("@nestjs/common").ExecutionContext): boolean {
    if (
      this.reflector.getAllAndOverride<boolean>(APP_ACCESS_PUBLIC, [
        context.getHandler(),
        context.getClass(),
      ])
    )
      return true;
    if (!this.access.required) return true;

    const request = context.switchToHttp().getRequest<Request>();
    if (!this.access.isAuthorized(request))
      throw new ForbiddenException("App-toegang vereist.");

    if (request.method !== "GET" && request.method !== "HEAD") {
      const origin = request.get("origin");
      const host = request.get("host");
      let sameOrigin: boolean;
      try {
        const parsed = new URL(origin ?? "");
        sameOrigin = Boolean(
          host &&
          parsed.protocol === "https:" &&
          parsed.host.toLowerCase() === host.toLowerCase(),
        );
      } catch {
        sameOrigin = false;
      }
      if (!sameOrigin)
        throw new ForbiddenException("Ongeldige oorsprong van verzoek.");
    }
    return true;
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "./settings.guard.js";
import { OmniRouteKeyModelAccess } from "./omniroute-key-model-access.service.js";

@Controller("settings/omniroute/accounts/keys/:id/model-access")
@UseGuards(SettingsGuard)
export class OmniRouteKeyModelAccessController {
  constructor(private readonly access: OmniRouteKeyModelAccess) {}

  @Get()
  get(@Param("id") id: string) {
    return this.access.options(id);
  }

  @Get("history")
  history(@Param("id") id: string) {
    return this.access.history(id);
  }

  @Post("prepare-rollback")
  @HttpCode(200)
  prepareRollback(@Param("id") id: string, @Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige modelrechtenhistorie."]);
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => !["revisionId", "acknowledgeGlobalEffect"].includes(key),
      ) ||
      typeof value.revisionId !== "string" ||
      typeof value.acknowledgeGlobalEffect !== "boolean"
    )
      throw new ValidationError(["Ongeldige modelrechtenhistorie."]);
    return this.access.prepareRollback(
      id,
      value.revisionId,
      value.acknowledgeGlobalEffect,
    );
  }

  @Post("prepare")
  @HttpCode(200)
  prepare(@Param("id") id: string, @Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige modelrechten."]);
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) =>
          !["allowedModels", "revision", "acknowledgeGlobalEffect"].includes(
            key,
          ),
      )
    )
      throw new ValidationError(["Ongeldige modelrechten."]);
    return this.access.prepare(
      id,
      value.allowedModels,
      value.revision,
      value.acknowledgeGlobalEffect,
    );
  }

  @Post("confirm")
  @HttpCode(200)
  confirm(@Param("id") id: string, @Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige bevestiging."]);
    const value = body as Record<string, unknown>;
    if (
      Object.keys(value).some(
        (key) => !["sessionId", "confirmationId", "approve"].includes(key),
      ) ||
      typeof value.sessionId !== "string" ||
      typeof value.confirmationId !== "string" ||
      typeof value.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.access.confirm(
      id,
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

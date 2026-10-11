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
import { OmniRouteTokenLimits } from "./omniroute-token-limits.service.js";

const input = (body: unknown, keys: string[]) => {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new ValidationError(["Ongeldige tokenlimietaanvraag."]);
  const value = body as Record<string, unknown>;
  if (Object.keys(value).some((key) => !keys.includes(key)))
    throw new ValidationError(["Ongeldige tokenlimietaanvraag."]);
  return value;
};

@Controller("settings/omniroute/accounts/keys/:id/token-limits")
@UseGuards(SettingsGuard)
export class OmniRouteTokenLimitsController {
  constructor(private readonly limits: OmniRouteTokenLimits) {}

  @Get()
  report(@Param("id") id: string) {
    return this.limits.report(id);
  }

  @Post("prepare")
  @HttpCode(200)
  prepare(@Param("id") id: string, @Body() body: unknown) {
    const value = input(body, [
      "tokenLimit",
      "resetInterval",
      "acknowledgeGlobalEffect",
    ]);
    return this.limits.prepare(
      id,
      value.tokenLimit,
      value.resetInterval,
      value.acknowledgeGlobalEffect,
    );
  }

  @Post("confirm")
  @HttpCode(200)
  confirm(@Param("id") id: string, @Body() body: unknown) {
    const value = input(body, ["sessionId", "confirmationId", "approve"]);
    if (
      typeof value.sessionId !== "string" ||
      typeof value.confirmationId !== "string" ||
      typeof value.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige tokenlimietbevestiging."]);
    return this.limits.confirm(
      id,
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

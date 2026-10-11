import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "./settings.guard.js";
import { OmniRouteComboUpdate } from "./omniroute-combo-update.service.js";

const input = (body: unknown, keys: string[]) => {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !keys.includes(key))
  )
    throw new ValidationError(["Ongeldige combo-aanvraag."]);
  return body as Record<string, unknown>;
};

@Controller("settings/omniroute/combos")
@UseGuards(SettingsGuard)
export class OmniRouteComboUpdateController {
  constructor(private readonly updateCombo: OmniRouteComboUpdate) {}
  @Post(":id/update/prepare")
  @HttpCode(200)
  prepare(@Param("id") id: string, @Body() body: unknown) {
    const value = input(body, ["name", "models", "acknowledgeGlobalEffect"]);
    return this.updateCombo.prepare(
      id,
      value.name,
      value.models,
      value.acknowledgeGlobalEffect,
    );
  }
  @Post(":id/update/confirm")
  @HttpCode(200)
  confirm(@Param("id") id: string, @Body() body: unknown) {
    const value = input(body, ["sessionId", "confirmationId", "approve"]);
    if (
      typeof value.sessionId !== "string" ||
      typeof value.confirmationId !== "string" ||
      typeof value.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.updateCombo.confirm(
      id,
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

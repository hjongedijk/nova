import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "./settings.guard.js";
import { OmniRouteComboCreate } from "./omniroute-combo-create.service.js";

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

@Controller("settings/omniroute/combos/create")
@UseGuards(SettingsGuard)
export class OmniRouteComboCreateController {
  constructor(private readonly createCombo: OmniRouteComboCreate) {}
  @Post("prepare") @HttpCode(200) prepare(@Body() body: unknown) {
    const value = input(body, ["name", "models", "acknowledgeGlobalEffect"]);
    return this.createCombo.prepare(
      value.name,
      value.models,
      value.acknowledgeGlobalEffect,
    );
  }
  @Post("confirm") @HttpCode(200) confirm(@Body() body: unknown) {
    const value = input(body, ["sessionId", "confirmationId", "approve"]);
    if (
      typeof value.sessionId !== "string" ||
      typeof value.confirmationId !== "string" ||
      typeof value.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.createCombo.confirm(
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

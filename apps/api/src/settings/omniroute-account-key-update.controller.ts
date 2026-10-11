import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "./settings.guard.js";
import { OmniRouteAccountKeyUpdate } from "./omniroute-account-key-update.service.js";

const input = (body: unknown, keys: string[]) => {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !keys.includes(key))
  )
    throw new ValidationError(["Ongeldige API-sleutelvervanging."]);
  return body as Record<string, unknown>;
};

@Controller("settings/omniroute/accounts/key-update")
@UseGuards(SettingsGuard)
export class OmniRouteAccountKeyUpdateController {
  constructor(private readonly updateKey: OmniRouteAccountKeyUpdate) {}

  @Post("prepare")
  @HttpCode(200)
  prepare(@Body() body: unknown) {
    const value = input(body, ["id", "apiKey", "acknowledgeEffects"]);
    return this.updateKey.prepare(
      value.id,
      value.apiKey,
      value.acknowledgeEffects,
    );
  }

  @Post("confirm")
  @HttpCode(200)
  confirm(@Body() body: unknown) {
    const value = input(body, ["sessionId", "confirmationId", "approve"]);
    if (
      typeof value.sessionId !== "string" ||
      typeof value.confirmationId !== "string" ||
      typeof value.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.updateKey.confirm(
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

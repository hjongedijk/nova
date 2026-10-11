import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "./settings.guard.js";
import { OmniRouteAccountCreate } from "./omniroute-account-create.service.js";

const input = (body: unknown, keys: string[]) => {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !keys.includes(key))
  )
    throw new ValidationError(["Ongeldige provideraccount-aanvraag."]);
  return body as Record<string, unknown>;
};

@Controller("settings/omniroute/accounts/create")
@UseGuards(SettingsGuard)
export class OmniRouteAccountCreateController {
  constructor(private readonly createAccount: OmniRouteAccountCreate) {}
  @Post("prepare")
  @HttpCode(200)
  prepare(@Body() body: unknown) {
    const value = input(body, [
      "provider",
      "name",
      "apiKey",
      "acknowledgeEffects",
    ]);
    return this.createAccount.prepare(
      value.provider,
      value.name,
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
    return this.createAccount.confirm(
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

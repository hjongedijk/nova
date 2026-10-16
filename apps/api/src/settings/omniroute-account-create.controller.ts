import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { SettingsGuard } from "./settings.guard.js";
import { OmniRouteAccountCreate } from "./omniroute-account-create.service.js";
import { assertConfirmation, strictBody } from "./request-input.js";

const input = (body: unknown, keys: string[]) =>
  strictBody(body, keys, "Ongeldige provideraccount-aanvraag.");

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
    assertConfirmation(value);
    return this.createAccount.confirm(
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

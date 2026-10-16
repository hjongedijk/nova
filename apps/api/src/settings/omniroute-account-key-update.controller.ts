import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { SettingsGuard } from "./settings.guard.js";
import { OmniRouteAccountKeyUpdate } from "./omniroute-account-key-update.service.js";
import { assertConfirmation, strictBody } from "./request-input.js";

const input = (body: unknown, keys: string[]) =>
  strictBody(body, keys, "Ongeldige API-sleutelvervanging.");

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
    assertConfirmation(value);
    return this.updateKey.confirm(
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

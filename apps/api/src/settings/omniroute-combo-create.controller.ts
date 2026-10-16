import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { SettingsGuard } from "./settings.guard.js";
import { OmniRouteComboCreate } from "./omniroute-combo-create.service.js";
import { assertConfirmation, strictBody } from "./request-input.js";

const input = (body: unknown, keys: string[]) =>
  strictBody(body, keys, "Ongeldige combo-aanvraag.");

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
    assertConfirmation(value);
    return this.createCombo.confirm(
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

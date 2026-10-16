import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { SettingsGuard } from "./settings.guard.js";
import { OmniRouteComboRemoval } from "./omniroute-combo-removal.service.js";
import { assertConfirmation, strictBody } from "./request-input.js";

const input = (body: unknown, keys: string[]) =>
  strictBody(body, keys, "Ongeldige combo-aanvraag.");
@Controller("settings/omniroute/combos/:id/removal")
@UseGuards(SettingsGuard)
export class OmniRouteComboRemovalController {
  constructor(private readonly removal: OmniRouteComboRemoval) {}
  @Post("prepare") @HttpCode(200) prepare(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ["acknowledgeEffects"]);
    return this.removal.prepare(id, value.acknowledgeEffects);
  }
  @Post("confirm") @HttpCode(200) confirm(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ["sessionId", "confirmationId", "approve"]);
    assertConfirmation(value);
    return this.removal.confirm(
      id,
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

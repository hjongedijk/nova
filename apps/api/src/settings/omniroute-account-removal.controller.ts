import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { SettingsGuard } from "./settings.guard.js";
import { OmniRouteAccountRemoval } from "./omniroute-account-removal.service.js";
import { assertConfirmation, strictBody } from "./request-input.js";
const input = (body: unknown, keys: string[]) =>
  strictBody(body, keys, "Ongeldige accountwijziging.");
@Controller("settings/omniroute/accounts/:id/removal")
@UseGuards(SettingsGuard)
export class OmniRouteAccountRemovalController {
  constructor(private readonly removal: OmniRouteAccountRemoval) {}
  @Post("prepare") @HttpCode(200) prepare(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    return this.removal.prepare(
      id,
      input(body, ["acknowledgeEffects"]).acknowledgeEffects,
    );
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

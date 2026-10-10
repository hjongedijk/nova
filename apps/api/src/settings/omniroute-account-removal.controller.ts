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
import { OmniRouteAccountRemoval } from "./omniroute-account-removal.service.js";
const input = (body: unknown, keys: string[]): Record<string, unknown> => {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !keys.includes(key))
  )
    throw new ValidationError(["Ongeldige accountwijziging."]);
  return body as Record<string, unknown>;
};
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
    if (
      typeof value.sessionId !== "string" ||
      typeof value.confirmationId !== "string" ||
      typeof value.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.removal.confirm(
      id,
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "./settings.guard.js";
import { OmniRouteAccountRename } from "./omniroute-account-rename.service.js";

const input = (body: unknown, keys: string[]) => {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !keys.includes(key))
  )
    throw new ValidationError(["Ongeldige accountnaamwijziging."]);
  return body as Record<string, unknown>;
};

@Controller("settings/omniroute/accounts/rename")
@UseGuards(SettingsGuard)
export class OmniRouteAccountRenameController {
  constructor(private readonly renameAccount: OmniRouteAccountRename) {}

  @Post("prepare")
  @HttpCode(200)
  prepare(@Body() body: unknown) {
    const value = input(body, ["id", "name", "acknowledgeEffects"]);
    return this.renameAccount.prepare(
      value.id,
      value.name,
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
      throw new ValidationError(["Ongeldige accountbevestiging."]);
    return this.renameAccount.confirm(
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

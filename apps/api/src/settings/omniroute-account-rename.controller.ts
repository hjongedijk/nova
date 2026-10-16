import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "./settings.guard.js";
import { OmniRouteAccountRename } from "./omniroute-account-rename.service.js";
import { strictBody } from "./request-input.js";

const input = (body: unknown, keys: string[]) =>
  strictBody(body, keys, "Ongeldige accountnaamwijziging.");

@Controller("settings/omniroute/accounts/rename")
@UseGuards(SettingsGuard)
export class OmniRouteAccountRenameController {
  constructor(private readonly renameAccount: OmniRouteAccountRename) {}

  @Get(":id/history")
  listHistory(@Param("id") id: string) {
    return this.renameAccount.listHistory(id);
  }

  @Post(":id/history/:revision/prepare-rollback")
  @HttpCode(200)
  prepareRollback(
    @Param("id") id: string,
    @Param("revision") revision: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ["acknowledgeEffects"]);
    return this.renameAccount.prepareRollback(
      id,
      revision,
      value.acknowledgeEffects,
    );
  }

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

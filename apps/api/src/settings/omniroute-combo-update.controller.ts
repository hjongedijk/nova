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
import { OmniRouteComboUpdate } from "./omniroute-combo-update.service.js";
import { OmniRouteComboUpdateHistory } from "./omniroute-combo-update-history.service.js";
import { assertConfirmation, strictBody } from "./request-input.js";

const input = (body: unknown, keys: string[]) =>
  strictBody(body, keys, "Ongeldige combo-aanvraag.");

@Controller("settings/omniroute/combos")
@UseGuards(SettingsGuard)
export class OmniRouteComboUpdateController {
  constructor(
    private readonly updateCombo: OmniRouteComboUpdate,
    private readonly history: OmniRouteComboUpdateHistory,
  ) {}
  @Get(":id/update/history")
  historyFor(@Param("id") id: string) {
    return this.history.list(id);
  }
  @Post(":id/update/history/:revision/prepare-rollback")
  @HttpCode(200)
  prepareRollback(
    @Param("id") id: string,
    @Param("revision") revision: string,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(revision))
      throw new ValidationError(["Ongeldige combo-wijziging."]);
    return this.updateCombo.prepareRollback(id, revision);
  }
  @Post(":id/update/prepare")
  @HttpCode(200)
  prepare(@Param("id") id: string, @Body() body: unknown) {
    const value = input(body, ["name", "models", "acknowledgeGlobalEffect"]);
    return this.updateCombo.prepare(
      id,
      value.name,
      value.models,
      value.acknowledgeGlobalEffect,
    );
  }
  @Post(":id/update/confirm")
  @HttpCode(200)
  confirm(@Param("id") id: string, @Body() body: unknown) {
    const value = input(body, ["sessionId", "confirmationId", "approve"]);
    assertConfirmation(value);
    return this.updateCombo.confirm(
      id,
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

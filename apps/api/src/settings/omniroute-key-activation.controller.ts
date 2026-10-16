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
import { OmniRouteKeyActivation } from "./omniroute-key-activation.service.js";
import { OmniRouteActivationHistory } from "./omniroute-activation-history.service.js";
import { assertConfirmation, strictBody } from "./request-input.js";

const input = (body: unknown, keys: string[]) =>
  strictBody(body, keys, "Ongeldige sleutelwijziging.");

@Controller("settings/omniroute/accounts/keys/:id/activation")
@UseGuards(SettingsGuard)
export class OmniRouteKeyActivationController {
  constructor(
    private readonly activation: OmniRouteKeyActivation,
    private readonly history: OmniRouteActivationHistory,
  ) {}
  @Get("history") historyList(@Param("id") id: string) {
    return this.history.list(id, "key");
  }
  @Post("history/:revision/prepare-rollback") @HttpCode(200) prepareRollback(
    @Param("id") id: string,
    @Param("revision") revision: string,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(revision))
      throw new ValidationError(["Ongeldige wijziging."]);
    const target = this.history.rollbackTarget(id, revision, "key");
    return this.activation.prepare(
      id,
      target.enabled,
      true,
      target.expectedCurrentRevision,
    );
  }
  @Post("prepare") @HttpCode(200) prepare(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ["enabled", "acknowledgeGlobalEffect"]);
    return this.activation.prepare(
      id,
      value.enabled,
      value.acknowledgeGlobalEffect,
    );
  }
  @Post("confirm") @HttpCode(200) confirm(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    const value = input(body, ["sessionId", "confirmationId", "approve"]);
    assertConfirmation(value);
    return this.activation.confirm(
      id,
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

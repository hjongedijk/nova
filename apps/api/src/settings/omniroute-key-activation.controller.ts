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

const input = (body: unknown, keys: string[]) => {
  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    Object.keys(body).some((key) => !keys.includes(key))
  )
    throw new ValidationError(["Ongeldige sleutelwijziging."]);
  return body as Record<string, unknown>;
};

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
    if (
      typeof value.sessionId !== "string" ||
      typeof value.confirmationId !== "string" ||
      typeof value.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.activation.confirm(
      id,
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }
}

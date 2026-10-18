import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { OmniRouteKeyActivation } from "./omniroute-key-activation.service.js";
import { OmniRouteActivationHistory } from "./omniroute-activation-history.service.js";
import { strictBody } from "./request-input.js";

@Controller("settings/omniroute/accounts/keys/:id/activation")
export class OmniRouteKeyActivationController {
  constructor(
    private readonly activation: OmniRouteKeyActivation,
    private readonly history: OmniRouteActivationHistory,
  ) {}
  @Get("history") historyList(@Param("id") id: string) {
    return this.history.list(id, "key");
  }
  @Post("history/:revision/rollback") @HttpCode(200) rollback(
    @Param("id") id: string,
    @Param("revision") revision: string,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(revision))
      throw new ValidationError(["Ongeldige wijziging."]);
    const target = this.history.rollbackTarget(id, revision, "key");
    return this.activation.apply(
      id,
      target.enabled,
      target.expectedCurrentRevision,
    );
  }
  @Post() @HttpCode(200) apply(@Param("id") id: string, @Body() body: unknown) {
    const value = strictBody(body, ["enabled"], "Ongeldige sleutelwijziging.");
    return this.activation.apply(id, value.enabled);
  }
}

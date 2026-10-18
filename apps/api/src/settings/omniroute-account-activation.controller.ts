import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { OmniRouteAccountActivation } from "./omniroute-account-activation.service.js";
import { OmniRouteActivationHistory } from "./omniroute-activation-history.service.js";
import { strictBody } from "./request-input.js";

@Controller("settings/omniroute/accounts/:id/activation")
export class OmniRouteAccountActivationController {
  constructor(
    private readonly activation: OmniRouteAccountActivation,
    private readonly history: OmniRouteActivationHistory,
  ) {}
  @Get("history")
  listHistory(@Param("id") id: string) {
    return this.history.list(id);
  }
  @Post("history/:revision/rollback")
  @HttpCode(200)
  rollback(@Param("id") id: string, @Param("revision") revision: string) {
    if (!/^[0-9a-f-]{36}$/i.test(revision))
      throw new ValidationError(["Ongeldige wijziging."]);
    const target = this.history.rollbackTarget(id, revision);
    return this.activation.set(
      id,
      target.enabled,
      target.expectedCurrentRevision,
    );
  }
  @Post() @HttpCode(200) set(@Param("id") id: string, @Body() body: unknown) {
    const value = strictBody(body, ["enabled"], "Ongeldige accountwijziging.");
    return this.activation.set(id, value.enabled);
  }
}

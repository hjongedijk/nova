import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { OmniRouteComboActivation } from "./omniroute-combo-activation.service.js";
import { OmniRouteActivationHistory } from "./omniroute-activation-history.service.js";
import { strictBody } from "./request-input.js";

const input = (body: unknown, keys: string[]) =>
  strictBody(body, keys, "Ongeldige combo-wijziging.");

@Controller("settings/omniroute/combos/:id/activation")
export class OmniRouteComboActivationController {
  constructor(
    private readonly activation: OmniRouteComboActivation,
    private readonly history: OmniRouteActivationHistory,
  ) {}

  @Get("history")
  listHistory(@Param("id") id: string) {
    return this.history.list(id, "combo");
  }

  @Post("history/:revision/rollback")
  @HttpCode(200)
  rollback(@Param("id") id: string, @Param("revision") revision: string) {
    if (!/^[0-9a-f-]{36}$/i.test(revision))
      throw new ValidationError(["Ongeldige wijziging."]);
    const target = this.history.rollbackTarget(id, revision, "combo");
    return this.activation.apply(
      id,
      target.enabled,
      target.expectedCurrentRevision,
    );
  }

  @Post()
  @HttpCode(200)
  apply(@Param("id") id: string, @Body() body: unknown) {
    const value = input(body, ["enabled"]);
    return this.activation.apply(id, value.enabled);
  }
}

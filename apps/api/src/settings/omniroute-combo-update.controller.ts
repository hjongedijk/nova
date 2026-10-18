import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { OmniRouteComboUpdate } from "./omniroute-combo-update.service.js";
import { OmniRouteComboUpdateHistory } from "./omniroute-combo-update-history.service.js";
import { strictBody } from "./request-input.js";

@Controller("settings/omniroute/combos")
export class OmniRouteComboUpdateController {
  constructor(
    private readonly updateCombo: OmniRouteComboUpdate,
    private readonly history: OmniRouteComboUpdateHistory,
  ) {}
  @Get(":id/update/history")
  historyFor(@Param("id") id: string) {
    return this.history.list(id);
  }
  @Post(":id/update/history/:revision/rollback")
  @HttpCode(200)
  rollback(@Param("id") id: string, @Param("revision") revision: string) {
    if (!/^[0-9a-f-]{36}$/i.test(revision))
      throw new ValidationError(["Ongeldige combo-wijziging."]);
    return this.updateCombo.rollback(id, revision);
  }
  @Post(":id/update")
  @HttpCode(200)
  update(@Param("id") id: string, @Body() body: unknown) {
    const value = strictBody(
      body,
      ["name", "models"],
      "Ongeldige combo-aanvraag.",
    );
    return this.updateCombo.update(id, value.name, value.models);
  }
}

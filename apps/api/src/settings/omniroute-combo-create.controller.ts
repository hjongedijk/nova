import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { OmniRouteComboCreate } from "./omniroute-combo-create.service.js";
import { strictBody } from "./request-input.js";

@Controller("settings/omniroute/combos/create")
export class OmniRouteComboCreateController {
  constructor(private readonly createCombo: OmniRouteComboCreate) {}
  @Post() @HttpCode(200) create(@Body() body: unknown) {
    const value = strictBody(
      body,
      ["name", "models"],
      "Ongeldige combo-aanvraag.",
    );
    return this.createCombo.create(value.name, value.models);
  }
}

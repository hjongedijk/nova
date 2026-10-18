import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { OmniRouteComboRemoval } from "./omniroute-combo-removal.service.js";
import { strictBody } from "./request-input.js";

@Controller("settings/omniroute/combos/:id/removal")
export class OmniRouteComboRemovalController {
  constructor(private readonly removal: OmniRouteComboRemoval) {}
  @Post() @HttpCode(200) remove(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    strictBody(body, [], "Ongeldige combo-aanvraag.");
    return this.removal.remove(id);
  }
}

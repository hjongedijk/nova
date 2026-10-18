import { Body, Controller, HttpCode, Param, Post } from "@nestjs/common";
import { OmniRouteAccountRemoval } from "./omniroute-account-removal.service.js";
import { strictBody } from "./request-input.js";

@Controller("settings/omniroute/accounts/:id/removal")
export class OmniRouteAccountRemovalController {
  constructor(private readonly removal: OmniRouteAccountRemoval) {}
  @Post() @HttpCode(200) remove(
    @Param("id") id: string,
    @Body() body: unknown,
  ) {
    strictBody(body ?? {}, [], "Ongeldige accountwijziging.");
    return this.removal.remove(id);
  }
}

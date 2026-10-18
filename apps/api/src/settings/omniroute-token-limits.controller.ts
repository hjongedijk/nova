import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { OmniRouteTokenLimits } from "./omniroute-token-limits.service.js";
import { strictBody } from "./request-input.js";

@Controller("settings/omniroute/accounts/keys/:id/token-limits")
export class OmniRouteTokenLimitsController {
  constructor(private readonly limits: OmniRouteTokenLimits) {}

  @Get()
  report(@Param("id") id: string) {
    return this.limits.report(id);
  }

  @Post()
  @HttpCode(200)
  apply(@Param("id") id: string, @Body() body: unknown) {
    const value = strictBody(
      body,
      ["tokenLimit", "resetInterval"],
      "Ongeldige tokenlimietaanvraag.",
    );
    return this.limits.apply(id, value.tokenLimit, value.resetInterval);
  }
}

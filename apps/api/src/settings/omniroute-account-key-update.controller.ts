import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { OmniRouteAccountKeyUpdate } from "./omniroute-account-key-update.service.js";
import { strictBody } from "./request-input.js";

@Controller("settings/omniroute/accounts/key-update")
export class OmniRouteAccountKeyUpdateController {
  constructor(private readonly updateKey: OmniRouteAccountKeyUpdate) {}

  @Post()
  @HttpCode(200)
  update(@Body() body: unknown) {
    const value = strictBody(
      body,
      ["id", "apiKey"],
      "Ongeldige API-sleutelvervanging.",
    );
    return this.updateKey.update(value.id, value.apiKey);
  }
}

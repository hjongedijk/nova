import { Body, Controller, HttpCode, Post } from "@nestjs/common";
import { OmniRouteAccountCreate } from "./omniroute-account-create.service.js";
import { strictBody } from "./request-input.js";

@Controller("settings/omniroute/accounts/create")
export class OmniRouteAccountCreateController {
  constructor(private readonly createAccount: OmniRouteAccountCreate) {}
  @Post()
  @HttpCode(200)
  create(@Body() body: unknown) {
    const value = strictBody(
      body,
      ["provider", "name", "apiKey"],
      "Ongeldige provideraccount-aanvraag.",
    );
    return this.createAccount.create(value.provider, value.name, value.apiKey);
  }
}

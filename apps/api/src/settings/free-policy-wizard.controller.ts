import { Body, Controller, Get, HttpCode, Post } from "@nestjs/common";
import { FreePolicyWizard } from "./free-policy-wizard.service.js";
@Controller("settings/omniroute/policy")
export class FreePolicyWizardController {
  constructor(private readonly wizard: FreePolicyWizard) {}
  @Get() options() {
    return this.wizard.options();
  }
  @Get("history") history() {
    return this.wizard.history();
  }
  @Post() @HttpCode(200) apply(@Body() body: unknown) {
    return this.wizard.apply(body);
  }
}

import {
  Body,
  Controller,
  Get,
  HttpCode,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "./settings.guard.js";
import { FreePolicyWizard } from "./free-policy-wizard.service.js";
@Controller("settings/omniroute/policy")
@UseGuards(SettingsGuard)
export class FreePolicyWizardController {
  constructor(private readonly wizard: FreePolicyWizard) {}
  @Get() options() {
    return this.wizard.options();
  }
  @Get("history") history() {
    return this.wizard.history();
  }
  @Post("prepare") @HttpCode(200) prepare(@Body() body: unknown) {
    return this.wizard.prepare(body);
  }
  @Post("confirm") @HttpCode(200) confirm(@Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige bevestiging."]);
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) => !["sessionId", "confirmationId", "approve"].includes(key),
      ) ||
      typeof input.sessionId !== "string" ||
      typeof input.confirmationId !== "string" ||
      typeof input.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.wizard.confirm(
      input.sessionId,
      input.confirmationId,
      input.approve,
    );
  }
}

import { Body, Controller, HttpCode, Post, UseGuards } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "./settings.guard.js";
import { NativePromptService } from "./native-prompt.service.js";
@Controller("settings/omniroute/native/prompt")
@UseGuards(SettingsGuard)
export class NativePromptController {
  constructor(private readonly prompt: NativePromptService) {}
  @Post("prepare") @HttpCode(200) prepare(@Body() body: unknown) {
    return this.prompt.prepare(body);
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
    return this.prompt.confirm(
      input.sessionId,
      input.confirmationId,
      input.approve,
    );
  }
}

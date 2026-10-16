import {
  Body,
  Controller,
  Get,
  Header,
  HttpCode,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "../settings/settings.guard.js";
import { ConversationService } from "./conversation.service.js";
import { ConversationSettingsStore } from "./conversation.settings.js";

/** Settings > Gesprekken: switch, language, greeting, limits, status and a hang-up button. Behind the settings PIN. */
@Controller("settings/conversation")
@UseGuards(SettingsGuard)
export class ConversationController {
  constructor(
    private readonly conversation: ConversationService,
    private readonly store: ConversationSettingsStore,
  ) {}

  @Get()
  @Header("Cache-Control", "no-store")
  overview() {
    const { secretUuid: _secret, ...settings } = this.store.get();
    void _secret;
    return { settings, status: this.conversation.status() };
  }

  @Put()
  async update(@Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige instellingen."]);
    const b = body as Record<string, unknown>;
    const allowed = [
      "enabled",
      "language",
      "greeting",
      "idleSeconds",
      "maxMinutes",
    ];
    const unknown = Object.keys(b).filter((key) => !allowed.includes(key));
    if (unknown.length)
      throw new ValidationError([`Onbekende instelling: ${unknown[0]}.`]);
    if (b.enabled !== undefined && typeof b.enabled !== "boolean")
      throw new ValidationError(["enabled moet waar of onwaar zijn."]);
    if (b.language !== undefined && b.language !== "nl" && b.language !== "en")
      throw new ValidationError(["Taal moet nl of en zijn."]);
    if (
      b.greeting !== undefined &&
      (typeof b.greeting !== "string" ||
        !b.greeting.trim() ||
        b.greeting.length > 200)
    )
      throw new ValidationError(["De begroeting moet 1 tot 200 tekens zijn."]);
    const { secretUuid: _secret, ...settings } =
      await this.conversation.setSettings(b as never);
    void _secret;
    return { settings, status: this.conversation.status() };
  }

  @Post("hangup")
  @HttpCode(200)
  hangup() {
    return { hungUp: this.conversation.hangUp() };
  }
}

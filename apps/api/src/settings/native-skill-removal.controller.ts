import {
  Body,
  Controller,
  HttpCode,
  Param,
  Post,
  UseGuards,
} from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { SettingsGuard } from "./settings.guard.js";
import { NativeSkillRemoval } from "./native-skill-removal.service.js";

@Controller("settings/omniroute/native/skills")
@UseGuards(SettingsGuard)
export class NativeSkillRemovalController {
  constructor(private readonly removal: NativeSkillRemoval) {}
  @Post(":id/remove/prepare")
  @HttpCode(200)
  prepare(@Param("id") id: string) {
    return this.removal.prepare(id);
  }
  @Post(":id/remove/confirm")
  @HttpCode(200)
  confirm(@Param("id") id: string, @Body() body: unknown) {
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
    return this.removal.confirm(
      id,
      input.sessionId,
      input.confirmationId,
      input.approve,
    );
  }
}

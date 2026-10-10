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
import { NativeSkillModesService } from "./native-skill-modes.service.js";

function body(value: unknown, fields: string[]): Record<string, unknown> {
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    Object.keys(value).some((key) => !fields.includes(key))
  )
    throw new ValidationError(["Ongeldige invoer."]);
  return value as Record<string, unknown>;
}
@Controller("settings/omniroute/native/skills")
@UseGuards(SettingsGuard)
export class NativeSkillModesController {
  constructor(private readonly modes: NativeSkillModesService) {}
  @Post(":id/prepare")
  @HttpCode(200)
  prepare(@Param("id") id: string, @Body() value: unknown) {
    const input = body(value, ["mode"]);
    return this.modes.prepare(id, input.mode);
  }
  @Post(":id/confirm")
  @HttpCode(200)
  confirm(@Param("id") id: string, @Body() value: unknown) {
    const input = body(value, ["sessionId", "confirmationId", "approve"]);
    if (
      typeof input.sessionId !== "string" ||
      typeof input.confirmationId !== "string" ||
      typeof input.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.modes.confirm(
      id,
      input.sessionId,
      input.confirmationId,
      input.approve,
    );
  }
}

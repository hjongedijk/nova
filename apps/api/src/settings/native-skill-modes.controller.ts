import {
  Body,
  Controller,
  Get,
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
  @Get(":id/history")
  history(@Param("id") id: string) {
    return this.modes.history(id);
  }
  @Post(":id/prepare")
  @HttpCode(200)
  prepare(@Param("id") id: string, @Body() value: unknown) {
    const input = body(value, ["mode", "acknowledgeGlobal"]);
    if (
      input.acknowledgeGlobal !== undefined &&
      typeof input.acknowledgeGlobal !== "boolean"
    )
      throw new ValidationError(["Ongeldige invoer."]);
    return this.modes.prepare(id, input.mode, input.acknowledgeGlobal === true);
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
  @Post(":id/rollback/prepare")
  @HttpCode(200)
  prepareRollback(@Param("id") id: string, @Body() value: unknown) {
    const input = body(value, ["revisionId", "acknowledgeGlobal"]);
    if (
      typeof input.revisionId !== "string" ||
      (input.acknowledgeGlobal !== undefined &&
        typeof input.acknowledgeGlobal !== "boolean")
    )
      throw new ValidationError(["Ongeldige skillgeschiedenisactie."]);
    return this.modes.prepareRollback(
      id,
      input.revisionId,
      input.acknowledgeGlobal === true,
    );
  }
}

import { Body, Controller, Get, HttpCode, Param, Post } from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
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
export class NativeSkillModesController {
  constructor(private readonly modes: NativeSkillModesService) {}
  @Get(":id/history")
  history(@Param("id") id: string) {
    return this.modes.history(id);
  }
  @Post(":id")
  @HttpCode(200)
  setMode(@Param("id") id: string, @Body() value: unknown) {
    const input = body(value, ["mode"]);
    return this.modes.setMode(id, input.mode);
  }
  @Post(":id/rollback")
  @HttpCode(200)
  rollback(@Param("id") id: string, @Body() value: unknown) {
    const input = body(value, ["revisionId"]);
    if (typeof input.revisionId !== "string")
      throw new ValidationError(["Ongeldige skillgeschiedenisactie."]);
    return this.modes.rollback(id, input.revisionId);
  }
}

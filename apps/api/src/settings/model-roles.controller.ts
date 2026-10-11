import {
  Body,
  Controller,
  Get,
  HttpCode,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import { ValidationError } from "../core/errors/validation.error.js";
import { ModelRolesService } from "./model-roles.service.js";
import { SettingsGuard } from "./settings.guard.js";

@Controller("settings/model-roles")
@UseGuards(SettingsGuard)
export class ModelRolesController {
  constructor(private readonly roles: ModelRolesService) {}

  @Get()
  get() {
    return this.roles.get();
  }

  @Put()
  save(@Body() body: unknown) {
    return this.roles.save(body);
  }

  @Get("history")
  history() {
    return this.roles.history();
  }

  @Post("history/:id/rollback")
  @HttpCode(200)
  rollback(@Param("id") id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige wijziging."]);
    return this.roles.rollback(id);
  }
}

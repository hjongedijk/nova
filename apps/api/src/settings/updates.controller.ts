import { Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { UpdatesService } from "./updates.service.js";
import { SettingsGuard } from "./settings.guard.js";
@Controller("settings/updates")
@UseGuards(SettingsGuard)
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}
  @Get() status() {
    return this.updates.status();
  }
  @Post("check") @HttpCode(200) check() {
    return this.updates.check();
  }
}

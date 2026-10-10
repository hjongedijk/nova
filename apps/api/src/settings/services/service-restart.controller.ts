import { Controller, Get, HttpCode, Post, UseGuards } from "@nestjs/common";
import { SettingsGuard } from "../settings.guard.js";
import { ServiceRestart } from "./service-restart.service.js";

@Controller("settings/services/restart")
@UseGuards(SettingsGuard)
export class ServiceRestartController {
  constructor(private readonly restart: ServiceRestart) {}

  @Get()
  status() {
    return this.restart.status();
  }

  @Post()
  @HttpCode(200)
  request() {
    return this.restart.request();
  }
}

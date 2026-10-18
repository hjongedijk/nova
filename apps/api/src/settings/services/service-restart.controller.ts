import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import { ServiceRestart } from "./service-restart.service.js";

@Controller("settings/services/restart")
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

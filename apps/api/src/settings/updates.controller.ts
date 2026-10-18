import { Controller, Get, HttpCode, Post } from "@nestjs/common";
import { UpdatesService } from "./updates.service.js";
@Controller("settings/updates")
export class UpdatesController {
  constructor(private readonly updates: UpdatesService) {}
  @Get() status() {
    return this.updates.status();
  }
  @Post("check") @HttpCode(200) check() {
    return this.updates.check();
  }
}

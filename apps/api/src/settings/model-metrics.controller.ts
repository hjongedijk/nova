import { Controller, Get, UseGuards } from "@nestjs/common";
import { ModelMetricsService } from "../routing/model-metrics.service.js";
import { SettingsGuard } from "./settings.guard.js";

@Controller("settings/models")
@UseGuards(SettingsGuard)
export class ModelMetricsController {
  constructor(private readonly metrics: ModelMetricsService) {}
  @Get("metrics") report() {
    return this.metrics.report();
  }
}

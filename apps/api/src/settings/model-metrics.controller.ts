import { Controller, Get } from "@nestjs/common";
import { ModelMetricsService } from "../routing/model-metrics.service.js";

@Controller("settings/models")
export class ModelMetricsController {
  constructor(private readonly metrics: ModelMetricsService) {}
  @Get("metrics") report() {
    return this.metrics.report();
  }
}

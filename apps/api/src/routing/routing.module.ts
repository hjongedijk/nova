import { RoutingManagementBarrier } from "./routing-management-barrier.service.js";
import { Module } from "@nestjs/common";
import { ModelMetricsService } from "./model-metrics.service.js";
import { OmniRouteManagement } from "./omniroute-management.service.js";
import { OmniRouteSource } from "./omniroute.source.js";
import { RoutingController } from "./routing.controller.js";
import { RoutingService } from "./routing.service.js";

/** Free-model routing through OmniRoute, and OmniRoute's management API. */
@Module({
  controllers: [RoutingController],
  providers: [
    RoutingService,
    RoutingManagementBarrier,
    OmniRouteManagement,
    OmniRouteSource,
    ModelMetricsService,
  ],
  exports: [
    RoutingService,
    RoutingManagementBarrier,
    OmniRouteManagement,
    ModelMetricsService,
  ],
})
export class RoutingModule {}

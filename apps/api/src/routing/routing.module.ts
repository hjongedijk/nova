import { Module } from "@nestjs/common";
import { OmniRouteManagement } from "./omniroute-management.service.js";
import { OmniRouteSource } from "./omniroute.source.js";
import { RoutingController } from "./routing.controller.js";
import { RoutingService } from "./routing.service.js";

/** Free-model routing through OmniRoute, and OmniRoute's management API. */
@Module({
  controllers: [RoutingController],
  providers: [RoutingService, OmniRouteManagement, OmniRouteSource],
  exports: [RoutingService, OmniRouteManagement],
})
export class RoutingModule {}

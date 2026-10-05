import { Controller, Get } from "@nestjs/common";
import {
  OmniRouteManagement,
  type OmniRouteStatus,
} from "./omniroute-management.service.js";
import { RoutingService, type RoutingStatus } from "./routing.service.js";

@Controller()
export class RoutingController {
  constructor(
    private readonly routing: RoutingService,
    private readonly management: OmniRouteManagement,
  ) {}

  /** GET /api/providers: the free-routing verdict plus the providers behind it. */
  @Get("providers")
  providers(): RoutingStatus & { providers: unknown[] } {
    return {
      ...this.routing.status(),
      providers: this.routing.providerInventory(),
    };
  }

  /** GET /api/gateway: OmniRoute's memory, skills, compression and cache. */
  @Get("gateway")
  gateway(): Promise<OmniRouteStatus> {
    return this.management.status();
  }
}

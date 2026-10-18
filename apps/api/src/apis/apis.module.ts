import { Global, Module } from "@nestjs/common";
import { PlanningModule } from "../planning/planning.module.js";
import { ApiEngine } from "./api-engine.service.js";
import { ApiMaintenanceService } from "./api-maintenance.service.js";
import { ApiRegistry } from "./api-registry.js";
import { ApiVault } from "./api-vault.js";
import { ApiSource } from "./api.source.js";
import { ApisController } from "./apis.controller.js";
import { LanDiscoveryService } from "./lan-discovery.service.js";
import { LanDiscoverySource } from "./lan-discovery.source.js";

/**
 * Universal API integration engine: discovers an API, learns a declarative spec, registers tools for it, keeps it healthy.
 * No learned or downloaded code ever runs; see docs/integrations.md#your-own-http-apis.
 */
@Global()
@Module({
  imports: [PlanningModule],
  controllers: [ApisController],
  providers: [
    ApiVault,
    ApiRegistry,
    ApiEngine,
    ApiSource,
    ApiMaintenanceService,
    LanDiscoveryService,
    LanDiscoverySource,
  ],
  exports: [ApiEngine, ApiVault, LanDiscoveryService],
})
export class ApisModule {}

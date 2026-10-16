import { Module } from "@nestjs/common";
import { ChecksModule } from "../checks/checks.module.js";
import { DashboardModule } from "../dashboard/dashboard.module.js";
import { HomeModule } from "../home/home.module.js";
import { ProxmoxModule } from "../proxmox/proxmox.module.js";
import { AiActivityVisualizationProvider } from "./providers/ai-activity.provider.js";
import { HomeVisualizationProvider } from "./providers/home.provider.js";
import { NetworkVisualizationProvider } from "./providers/network.provider.js";
import { ProxmoxVisualizationProvider } from "./providers/proxmox.provider.js";
import { VisualizationController } from "./visualization.controller.js";
import { VisualizationRegistry } from "./visualization.registry.js";
import { VisualizationService } from "./visualization.service.js";
import { VisualizationSource } from "./visualization.source.js";

/**
 * The holographic visualisation platform: a registry other modules add providers to, the scene
 * service, the visualisation tools and the REST API of the viewer. Exports the registry and the
 * service. See docs/holographic-engine.md.
 */
@Module({
  imports: [ProxmoxModule, HomeModule, ChecksModule, DashboardModule],
  controllers: [VisualizationController],
  providers: [
    VisualizationRegistry,
    VisualizationService,
    VisualizationSource,
    ProxmoxVisualizationProvider,
    AiActivityVisualizationProvider,
    HomeVisualizationProvider,
    NetworkVisualizationProvider,
  ],
  exports: [VisualizationRegistry, VisualizationService],
})
export class VisualizationModule {}

import { Module } from "@nestjs/common";
import { ChecksModule } from "../checks/checks.module.js";
import { HomeModule } from "../home/home.module.js";
import { BrowserAgentModule } from "../integrations/browser-agent/browser-agent.module.js";
import { McpModule } from "../integrations/mcp/mcp.module.js";
import { PangolinModule } from "../integrations/pangolin/pangolin.module.js";
import { TermixModule } from "../integrations/termix/termix.module.js";
import { WindowsModule } from "../integrations/windows/windows.module.js";
import { WorldModule } from "../integrations/world/world.module.js";
import { MemoryModule } from "../memory/memory.module.js";
import { PlanningModule } from "../planning/planning.module.js";
import { ProxmoxModule } from "../proxmox/proxmox.module.js";
import { RoutingModule } from "../routing/routing.module.js";
import { AlertsFeed } from "./alerts-feed.service.js";
import { DashboardController } from "./dashboard.controller.js";
import { HostMetricsService } from "./host-metrics.service.js";
import { IntegrationsHealth } from "./integrations-health.service.js";
import { OverviewService } from "./overview.service.js";
import { SystemSource } from "./system.source.js";

/** Home-screen data: this machine, the side panels, the unasked-for alerts, and the health of everything. */
@Module({
  imports: [
    ProxmoxModule,
    PlanningModule,
    ChecksModule,
    HomeModule,
    MemoryModule,
    RoutingModule,
    WorldModule,
    McpModule,
    TermixModule,
    PangolinModule,
    WindowsModule,
    BrowserAgentModule,
  ],
  controllers: [DashboardController],
  providers: [
    HostMetricsService,
    OverviewService,
    AlertsFeed,
    IntegrationsHealth,
    SystemSource,
  ],
  exports: [HostMetricsService, OverviewService, IntegrationsHealth],
})
export class DashboardModule {}

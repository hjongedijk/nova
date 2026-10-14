import { Module } from "@nestjs/common";
import { AppAccessModule } from "../access/access.module.js";
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
import { SettingsStoreModule } from "../settings/store/settings-store.module.js";
import { NodeRedFlowRevisionsModule } from "../settings/node-red-flow-revisions.module.js";
import { AlertsFeed } from "./alerts-feed.service.js";
import { DashboardController } from "./dashboard.controller.js";
import { HostMetricsService } from "./host-metrics.service.js";
import { IntegrationsHealth } from "./integrations-health.service.js";
import { OverviewService } from "./overview.service.js";
import { SystemSource } from "./system.source.js";
import { NodeRedHealth } from "./node-red-health.service.js";
import { NodeRedEventsController } from "./node-red-events.controller.js";
import { NodeRedBriefingSource } from "./node-red-briefing.source.js";
import { NodeRedFlowSource } from "./node-red-flow.source.js";
import { DataBackupService } from "./data-backup.service.js";
import { SpeechPresenceService } from "./speech-presence.service.js";
import { WeatherDepartureAlertService } from "./weather-departure-alert.service.js";
import { NtfyPushService } from "./ntfy-push.service.js";
import { RitualsService } from "./rituals.service.js";
import { WeeklyOverviewService } from "./weekly-overview.service.js";
import { DailyHighlightService } from "./daily-highlight.service.js";
import { CalendarReminderService } from "./calendar-reminder.service.js";
import { SmallSurprisesService } from "./small-surprises.service.js";

/** Home-screen data: this machine, the side panels, the unasked-for alerts, and the health of everything. */
@Module({
  imports: [
    AppAccessModule,
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
    SettingsStoreModule,
    NodeRedFlowRevisionsModule,
  ],
  controllers: [DashboardController, NodeRedEventsController],
  providers: [
    HostMetricsService,
    OverviewService,
    AlertsFeed,
    IntegrationsHealth,
    SystemSource,
    NodeRedHealth,
    NodeRedFlowSource,
    NodeRedBriefingSource,
    DataBackupService,
    SpeechPresenceService,
    WeatherDepartureAlertService,
    NtfyPushService,
    RitualsService,
    WeeklyOverviewService,
    DailyHighlightService,
    CalendarReminderService,
    SmallSurprisesService,
  ],
  exports: [HostMetricsService, OverviewService, IntegrationsHealth],
})
export class DashboardModule {}

import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import { ChatModule } from "../chat/chat.module.js";
import { HomeModule } from "../home/home.module.js";
import { McpModule } from "../integrations/mcp/mcp.module.js";
import { ObjectivesModule } from "../objectives/objectives.module.js";
import { PlanningModule } from "../planning/planning.module.js";
import { RoutingModule } from "../routing/routing.module.js";
import { SettingsGuard } from "../settings/settings.guard.js";
import { TelephonyModule } from "../telephony/telephony.module.js";
import {
  AutopilotController,
  AutopilotSettingsController,
} from "./autopilot.controller.js";
import { AutopilotService } from "./autopilot.service.js";
import { AutopilotSource } from "./autopilot.source.js";
import { AutopilotStore } from "./autopilot.store.js";

/**
 * The always-on autopilot: deterministic routine scans, unprompted alerts and texts, default standing objectives and direct
 * delegation. See docs/autopilot.md.
 */
@Module({
  imports: [
    AgentModule,
    ChatModule,
    HomeModule,
    McpModule,
    ObjectivesModule,
    PlanningModule,
    RoutingModule,
    TelephonyModule,
  ],
  controllers: [AutopilotController, AutopilotSettingsController],
  providers: [AutopilotStore, AutopilotService, AutopilotSource, SettingsGuard],
})
export class AutopilotModule {}

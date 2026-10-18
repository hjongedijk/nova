import { Module } from "@nestjs/common";
import { ChatModule } from "../chat/chat.module.js";
import { PlanningModule } from "../planning/planning.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { AgentController } from "./agent.controller.js";
import { AgentService } from "./agent.service.js";
import { AgentSource } from "./agent.source.js";
import { AgentStore } from "./agent.store.js";

/**
 * Background goals: NOVA works through a goal turn after turn with her normal tools and the chosen autonomy level, within
 * hard turn, time and daily budgets, and reports back. See docs/features.md#autopilot-nova-takes-initiative.
 */
@Module({
  imports: [ChatModule, PlanningModule, ToolsModule],
  controllers: [AgentController],
  providers: [AgentStore, AgentService, AgentSource],
  exports: [AgentService],
})
export class AgentModule {}

import { Module } from "@nestjs/common";
import { AgentModule } from "../agent/agent.module.js";
import { PlanningModule } from "../planning/planning.module.js";
import { ToolsModule } from "../tools/tools.module.js";
import { ObjectivesController } from "./objectives.controller.js";
import { ObjectivesService } from "./objectives.service.js";
import { ObjectivesSource } from "./objectives.source.js";
import { ObjectivesStore } from "./objectives.store.js";

/**
 * Standing objectives: ongoing goals NOVA keeps watching with read-only tools, without a model call for routine checks.
 * See docs/features.md#standing-objectives.
 */
@Module({
  imports: [AgentModule, PlanningModule, ToolsModule],
  controllers: [ObjectivesController],
  providers: [ObjectivesStore, ObjectivesService, ObjectivesSource],
  exports: [ObjectivesService],
})
export class ObjectivesModule {}

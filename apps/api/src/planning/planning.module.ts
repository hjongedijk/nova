import { Module } from "@nestjs/common";
import { ProxmoxModule } from "../proxmox/proxmox.module.js";
import { JarvisStateStore } from "./jarvis-state.store.js";
import { PlanningService } from "./planning.service.js";
import { PlanningSource } from "./planning.source.js";
import { CalDavService } from "./caldav.service.js";
import { CookingController } from "./cooking.controller.js";
import { AutonomyController } from "./autonomy/autonomy.controller.js";
import { AutonomyService } from "./autonomy/autonomy.service.js";
import { AutonomySource } from "./autonomy/autonomy.source.js";
import { AutonomyStore } from "./autonomy/autonomy.store.js";
import { HomeModule } from "../home/home.module.js";

/**
 * Timers, lists and the daily briefing, persisted in jarvis-state.json. Exports PlanningService
 * (timers(), lists(), onEvent()) and the JarvisStateStore the checks module shares.
 */
@Module({
  imports: [ProxmoxModule, HomeModule],
  controllers: [CookingController, AutonomyController],
  providers: [
    JarvisStateStore,
    PlanningService,
    PlanningSource,
    CalDavService,
    AutonomyStore,
    AutonomyService,
    AutonomySource,
  ],
  exports: [PlanningService, JarvisStateStore, CalDavService],
})
export class PlanningModule {}

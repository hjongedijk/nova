import { Module } from "@nestjs/common";
import { ProxmoxModule } from "../proxmox/proxmox.module.js";
import { JarvisStateStore } from "./jarvis-state.store.js";
import { PlanningService } from "./planning.service.js";
import { PlanningSource } from "./planning.source.js";

/**
 * Timers, lists and the daily briefing, persisted in jarvis-state.json. Exports PlanningService
 * (timers(), lists(), onEvent()) and the JarvisStateStore the checks module shares.
 */
@Module({
  imports: [ProxmoxModule],
  providers: [JarvisStateStore, PlanningService, PlanningSource],
  exports: [PlanningService, JarvisStateStore],
})
export class PlanningModule {}

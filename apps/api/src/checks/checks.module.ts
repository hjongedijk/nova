import { Module } from "@nestjs/common";
import { PlanningModule } from "../planning/planning.module.js";
import { ProxmoxModule } from "../proxmox/proxmox.module.js";
import { ChecksService } from "./checks.service.js";
import { ChecksSource } from "./checks.source.js";

/** Reachability checks, the watchdog and alerts. Exports ChecksService (alerts()). */
@Module({
  imports: [PlanningModule, ProxmoxModule],
  providers: [ChecksService, ChecksSource],
  exports: [ChecksService],
})
export class ChecksModule {}

import { Module } from "@nestjs/common";
import { ProxmoxService } from "./proxmox.service.js";
import { ProxmoxSource } from "./proxmox.source.js";
import { SystemTimeSource } from "./system-time.source.js";
import { ManagedTargetsAccessModule } from "../settings/managed-targets-access.module.js";

/** Proxmox status, guests, storage and start/stop, plus system_time. Exports ProxmoxService. */
@Module({
  imports: [ManagedTargetsAccessModule],
  providers: [ProxmoxService, ProxmoxSource, SystemTimeSource],
  exports: [ProxmoxService],
})
export class ProxmoxModule {}

import { Module } from "@nestjs/common";
import { PangolinService } from "./pangolin.service.js";
import { ManagedTargetsAccessModule } from "../../settings/managed-targets-access.module.js";

@Module({
  imports: [ManagedTargetsAccessModule],
  providers: [PangolinService],
  exports: [PangolinService],
})
export class PangolinModule {}

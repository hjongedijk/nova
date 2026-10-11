import { Module } from "@nestjs/common";
import { TermixService } from "./termix.service.js";
import { ManagedTargetsAccessModule } from "../../settings/managed-targets-access.module.js";

@Module({
  imports: [ManagedTargetsAccessModule],
  providers: [TermixService],
  exports: [TermixService],
})
export class TermixModule {}

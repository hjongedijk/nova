import { Module } from "@nestjs/common";
import { ManagedTargetsAccessStore } from "./managed-targets-access.store.js";

@Module({
  providers: [ManagedTargetsAccessStore],
  exports: [ManagedTargetsAccessStore],
})
export class ManagedTargetsAccessModule {}

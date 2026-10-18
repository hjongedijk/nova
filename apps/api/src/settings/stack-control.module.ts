import { Module } from "@nestjs/common";
import { StackControlService } from "./stack-control.service.js";

@Module({
  providers: [StackControlService],
  exports: [StackControlService],
})
export class StackControlModule {}

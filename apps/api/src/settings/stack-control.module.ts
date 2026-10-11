import { Module } from "@nestjs/common";
import { ConfirmationsModule } from "../confirmations/confirmations.module.js";
import { StackControlService } from "./stack-control.service.js";

@Module({
  imports: [ConfirmationsModule],
  providers: [StackControlService],
  exports: [StackControlService],
})
export class StackControlModule {}

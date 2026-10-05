import { Module } from "@nestjs/common";
import { ConfirmationsService } from "./confirmations.service.js";

/**
 * Pending confirmations for risky actions: the store, and the words for asking and answering.
 * The /api/actions/confirm endpoint lives in the chat module, which runs the approved action.
 */
@Module({
  providers: [ConfirmationsService],
  exports: [ConfirmationsService],
})
export class ConfirmationsModule {}

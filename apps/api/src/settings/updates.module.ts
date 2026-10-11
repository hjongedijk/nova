import { Module } from "@nestjs/common";
import { UpdatesService } from "./updates.service.js";

@Module({
  providers: [UpdatesService],
  exports: [UpdatesService],
})
export class UpdatesModule {}

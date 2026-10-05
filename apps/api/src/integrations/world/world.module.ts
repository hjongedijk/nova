import { Module } from "@nestjs/common";
import { WorldService } from "./world.service.js";
import { WorldSource } from "./world.source.js";

/**
 * The world outside the house. Other modules inject WorldService. To feed it Home Assistant's
 * zone.home, call WorldService.useHomeSource() from that module.
 */
@Module({
  providers: [WorldService, WorldSource],
  exports: [WorldService],
})
export class WorldModule {}

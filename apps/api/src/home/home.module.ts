import { Module } from "@nestjs/common";
import { MemoryModule } from "../memory/memory.module.js";
import { HomeAssistantService } from "./home-assistant.service.js";
import { HomeController } from "./home.controller.js";
import { HomeSource } from "./home.source.js";
import { HomeSummaryService } from "./home-summary.service.js";

/**
 * Home Assistant: catalog and client, the ha_*, media_*, sonos_* and home_status tools, and
 * GET /api/entities. Exports HomeAssistantService and HomeSummaryService. Long-term memory may
 * add learned names by providing HOME_ALIAS_LOOKUP (optional).
 */
@Module({
  imports: [MemoryModule],
  controllers: [HomeController],
  providers: [HomeAssistantService, HomeSummaryService, HomeSource],
  exports: [HomeAssistantService, HomeSummaryService],
})
export class HomeModule {}

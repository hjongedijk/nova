import { Module } from "@nestjs/common";
import { DesktopModule } from "../desktop/desktop.module.js";
import { WorldModule } from "../integrations/world/world.module.js";
import { LiveController } from "./live.controller.js";
import { LiveStreamsService } from "./live-streams.service.js";
import { WindowSource } from "./window.source.js";

/**
 * NOVA's floating windows: live video of the PC's browser and screen (served on the /api/live websocket, which
 * main.ts attaches), and the window_open tool for videos, pages, images and documents.
 */
@Module({
  imports: [DesktopModule, WorldModule],
  controllers: [LiveController],
  providers: [LiveStreamsService, WindowSource],
  exports: [LiveStreamsService],
})
export class LiveModule {}

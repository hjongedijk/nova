import { Module } from "@nestjs/common";
import { RoutingModule } from "../routing/routing.module.js";
import { DesktopAgentClient } from "./desktop.agent-client.js";
import { DesktopController } from "./desktop.controller.js";
import { DesktopService } from "./desktop.service.js";
import { DesktopSource } from "./desktop.source.js";
import { DESKTOP_PORT, DESKTOP_VISION } from "./desktop.types.js";
import { OmniRouteDesktopVision } from "./desktop.vision.js";
import { DesktopSettingsStore } from "./desktop-settings.store.js";

/**
 * NOVA sees and, in a short confirmed session, operates the user's PC desktop through the Windows agent.
 * Everything is off until the user switches it on in the settings.
 */
@Module({
  imports: [RoutingModule],
  controllers: [DesktopController],
  providers: [
    DesktopSettingsStore,
    DesktopAgentClient,
    OmniRouteDesktopVision,
    { provide: DESKTOP_PORT, useExisting: DesktopAgentClient },
    { provide: DESKTOP_VISION, useExisting: OmniRouteDesktopVision },
    DesktopService,
    DesktopSource,
  ],
  exports: [DesktopService],
})
export class DesktopModule {}

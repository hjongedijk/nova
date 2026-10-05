import { Global, Inject, Module, type OnModuleInit } from "@nestjs/common";
import { HomeAssistantService } from "../home/home-assistant.service.js";
import {
  HOME_ALIAS_LOOKUP,
  type HomeAliasLookup,
} from "../home/alias-lookup.js";
import { HomeModule } from "../home/home.module.js";
import { WindowsModule } from "../integrations/windows/windows.module.js";
import { WindowsPcService } from "../integrations/windows/windows-pc.service.js";
import { WorldModule } from "../integrations/world/world.module.js";
import { WorldService } from "../integrations/world/world.service.js";
import { MemoryModule } from "../memory/memory.module.js";
import { SemanticMemoryService } from "../memory/semantic-memory.service.js";
import { OmniRouteClient } from "../chat/omniroute-client.service.js";
import { RoutingModule } from "../routing/routing.module.js";
import { LLM_CLIENT } from "../settings/llm-client.js";
import {
  WALLPAPER_PORT,
  type WallpaperPort,
} from "../settings/wallpaper.port.js";

/**
 * The few places where one module needs something another one owns, but only by an agreed shape.
 * Keeping the glue here keeps those modules independent of each other:
 *   - the settings screen asks the language model for help (LLM_CLIENT) and sets the Windows wallpaper
 *     (WALLPAPER_PORT) without knowing OmniRoute or the Windows agent;
 *   - Home Assistant resolves names the user taught NOVA (HOME_ALIAS_LOOKUP) through long-term memory;
 *   - "home" for the weather follows Home Assistant's zone.home.
 */
@Global()
@Module({
  imports: [
    RoutingModule,
    WindowsModule,
    MemoryModule,
    HomeModule,
    WorldModule,
  ],
  providers: [
    OmniRouteClient,
    { provide: LLM_CLIENT, useExisting: OmniRouteClient },
    {
      provide: WALLPAPER_PORT,
      inject: [WindowsPcService],
      useFactory: (windows: WindowsPcService): WallpaperPort => ({
        get configured() {
          return windows.configured;
        },
        async displays() {
          const outcome = await windows.displays();
          return outcome.ok
            ? { ok: true, displays: outcome.result.displays }
            : { ok: false, error: outcome.error };
        },
        async setWallpaper(display, mode) {
          const outcome = await windows.setWallpaper(display, mode);
          return outcome.ok
            ? { ok: true, displays: outcome.result.displays }
            : { ok: false, error: outcome.error };
        },
      }),
    },
    {
      provide: HOME_ALIAS_LOOKUP,
      inject: [SemanticMemoryService],
      useFactory: (semantic: SemanticMemoryService): HomeAliasLookup => ({
        async relatedEntity(reference) {
          const needle = reference.toLowerCase();
          const found = (await semantic.search(reference)).find(
            (memory) =>
              memory.type === "LEARNED_ALIAS" &&
              memory.text.toLowerCase().includes(needle),
          );
          return found?.related_entity ?? null;
        },
      }),
    },
  ],
  exports: [OmniRouteClient, LLM_CLIENT, WALLPAPER_PORT, HOME_ALIAS_LOOKUP],
})
export class BridgesModule implements OnModuleInit {
  constructor(
    @Inject(WorldService) private readonly world: WorldService,
    @Inject(HomeAssistantService) private readonly home: HomeAssistantService,
  ) {}

  onModuleInit(): void {
    this.world.useHomeSource({
      sync: async () => void (await this.home.sync()),
      zoneHome: () => {
        const zone = this.home.entities.find(
          (entity) => entity.entity_id === "zone.home",
        );
        const latitude = zone?.attributes?.latitude;
        const longitude = zone?.attributes?.longitude;
        return typeof latitude === "number" && typeof longitude === "number"
          ? { latitude, longitude, name: "thuis" }
          : null;
      },
    });
  }
}

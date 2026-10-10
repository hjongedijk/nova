import { Module } from "@nestjs/common";
import { SettingsSource } from "./settings.source.js";
import { SettingsMutationsService } from "./settings-mutations.service.js";
import { UpdatesController } from "./updates.controller.js";
import { UpdatesService } from "./updates.service.js";
import { RoutingModule } from "../routing/routing.module.js";
import { ModelMetricsController } from "./model-metrics.controller.js";
import { ServiceConnectionsController } from "./services/service-connections.controller.js";
import { ServiceConnectionsStore } from "./services/service-connections.store.js";
import { ServiceConnectionsAdapter } from "./services/service-connections.adapter.js";
import { SkillAssistantService } from "./ai/skill-assistant.service.js";
import { PlaybooksService } from "./playbooks.service.js";
import { PublicConfigService } from "./public-config.service.js";
import { SettingsController } from "./settings.controller.js";
import { SettingsGuard } from "./settings.guard.js";
import { SkillsSource } from "./skills/skills.source.js";
import { SettingsStoreModule } from "./store/settings-store.module.js";
import { WidgetDataService } from "./widgets/widget-data.service.js";
import { WidgetsController } from "./widgets/widgets.controller.js";

/**
 * Skills, persona, quick actions, sidebar panels, backup: /api/settings and /api/widgets.
 *
 * Optional providers other modules supply under their own tokens:
 *   - LLM_CLIENT (llm-client.ts): the plain model call for "improve" and "draft" a skill.
 *   - WALLPAPER_PORT (wallpaper.port.ts): the wallpaper on the Windows PC.
 * Exports PlaybooksService (relevantPlaybooks, formatPlaybooks, quickActions, persona) and
 * PublicConfigService for the chat and the dashboard.
 */
@Module({
  imports: [SettingsStoreModule, RoutingModule],
  controllers: [
    SettingsController,
    WidgetsController,
    ServiceConnectionsController,
    ModelMetricsController,
    UpdatesController,
  ],
  providers: [
    SettingsGuard,
    SettingsMutationsService,
    SettingsSource,
    UpdatesService,
    ServiceConnectionsStore,
    ServiceConnectionsAdapter,
    SkillsSource,
    PlaybooksService,
    PublicConfigService,
    SkillAssistantService,
    WidgetDataService,
  ],
  exports: [PlaybooksService, PublicConfigService, SkillAssistantService],
})
export class SettingsModule {}

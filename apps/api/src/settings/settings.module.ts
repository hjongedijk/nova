import { ToolUsageController } from "./tool-usage.controller.js";
import { SettingsBackupService } from "./settings-backup.service.js";
import { FreePolicyWizardController } from "./free-policy-wizard.controller.js";
import { FreePolicyWizard } from "./free-policy-wizard.service.js";
import { OmniRouteAccountRemovalController } from "./omniroute-account-removal.controller.js";
import { OmniRouteAccountRemoval } from "./omniroute-account-removal.service.js";
import { OmniRouteAccountsController } from "./omniroute-accounts.controller.js";
import { Module } from "@nestjs/common";
import { SettingsSource } from "./settings.source.js";
import { ConfirmationsModule } from "../confirmations/confirmations.module.js";
import { NativeGatewayController } from "./native-gateway.controller.js";
import { NativeSkillModesController } from "./native-skill-modes.controller.js";
import { NativeSkillModesService } from "./native-skill-modes.service.js";
import { NativePromptController } from "./native-prompt.controller.js";
import { NativePromptService } from "./native-prompt.service.js";
import { SettingsMutationsService } from "./settings-mutations.service.js";
import { UpdatesController } from "./updates.controller.js";
import { UpdatesService } from "./updates.service.js";
import { RoutingModule } from "../routing/routing.module.js";
import { ModelMetricsController } from "./model-metrics.controller.js";
import { ServiceConnectionsController } from "./services/service-connections.controller.js";
import { ServiceConnectionsStore } from "./services/service-connections.store.js";
import { ServiceConnectionsAdapter } from "./services/service-connections.adapter.js";
import { ServiceRestartController } from "./services/service-restart.controller.js";
import { ServiceRestart } from "./services/service-restart.service.js";
import { HelperPreferencesHistory } from "./helper-preferences-history.service.js";
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
  imports: [SettingsStoreModule, RoutingModule, ConfirmationsModule],
  controllers: [
    SettingsController,
    ToolUsageController,
    WidgetsController,
    ServiceConnectionsController,
    ServiceRestartController,
    ModelMetricsController,
    UpdatesController,
    NativeGatewayController,
    NativeSkillModesController,
    NativePromptController,
    OmniRouteAccountsController,
    OmniRouteAccountRemovalController,
    FreePolicyWizardController,
  ],
  providers: [
    SettingsGuard,
    SettingsMutationsService,
    SettingsBackupService,
    SettingsSource,
    NativeSkillModesService,
    NativePromptService,
    OmniRouteAccountRemoval,
    FreePolicyWizard,
    UpdatesService,
    ServiceConnectionsStore,
    ServiceConnectionsAdapter,
    ServiceRestart,
    HelperPreferencesHistory,
    SkillsSource,
    PlaybooksService,
    PublicConfigService,
    SkillAssistantService,
    WidgetDataService,
  ],
  exports: [PlaybooksService, PublicConfigService, SkillAssistantService],
})
export class SettingsModule {}

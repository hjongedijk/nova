import { ToolUsageController } from "./tool-usage.controller.js";
import { SettingsBackupService } from "./settings-backup.service.js";
import { FreePolicyWizardController } from "./free-policy-wizard.controller.js";
import { FreePolicyWizard } from "./free-policy-wizard.service.js";
import { OmniRouteAccountRemovalController } from "./omniroute-account-removal.controller.js";
import { OmniRouteAccountRemoval } from "./omniroute-account-removal.service.js";
import { OmniRouteAccountsController } from "./omniroute-accounts.controller.js";
import { OmniRouteComboActivationController } from "./omniroute-combo-activation.controller.js";
import { OmniRouteComboActivation } from "./omniroute-combo-activation.service.js";
import { ModelRolesController } from "./model-roles.controller.js";
import { ModelRolesService } from "./model-roles.service.js";
import { OmniRouteAccountActivationController } from "./omniroute-account-activation.controller.js";
import { OmniRouteAccountActivation } from "./omniroute-account-activation.service.js";
import { OmniRouteActivationHistory } from "./omniroute-activation-history.service.js";
import { OmniRouteKeyActivationController } from "./omniroute-key-activation.controller.js";
import { OmniRouteKeyActivation } from "./omniroute-key-activation.service.js";
import { OmniRouteKeyModelAccessController } from "./omniroute-key-model-access.controller.js";
import { OmniRouteKeyModelAccess } from "./omniroute-key-model-access.service.js";
import { OmniRouteComboCreateController } from "./omniroute-combo-create.controller.js";
import { OmniRouteComboCreate } from "./omniroute-combo-create.service.js";
import { OmniRouteComboRemovalController } from "./omniroute-combo-removal.controller.js";
import { OmniRouteComboRemoval } from "./omniroute-combo-removal.service.js";
import { OmniRouteComboUpdateController } from "./omniroute-combo-update.controller.js";
import { OmniRouteComboUpdate } from "./omniroute-combo-update.service.js";
import { OmniRouteAccountCreateController } from "./omniroute-account-create.controller.js";
import { OmniRouteAccountCreate } from "./omniroute-account-create.service.js";
import { OmniRouteAccountKeyUpdateController } from "./omniroute-account-key-update.controller.js";
import { OmniRouteAccountKeyUpdate } from "./omniroute-account-key-update.service.js";
import { Module } from "@nestjs/common";
import { PlanningModule } from "../planning/planning.module.js";
import { SettingsSource } from "./settings.source.js";
import { ConfirmationsModule } from "../confirmations/confirmations.module.js";
import { NativeGatewayController } from "./native-gateway.controller.js";
import { NativeSkillModesController } from "./native-skill-modes.controller.js";
import { NativeSkillModesService } from "./native-skill-modes.service.js";
import { NativeSkillRemovalController } from "./native-skill-removal.controller.js";
import { NativeSkillRemoval } from "./native-skill-removal.service.js";
import { NativePromptController } from "./native-prompt.controller.js";
import { NativePromptService } from "./native-prompt.service.js";
import { NativeMemorySettingsService } from "./native-memory-settings.service.js";
import { NativeMemoryRecordsService } from "./native-memory-records.service.js";
import { SettingsMutationsService } from "./settings-mutations.service.js";
import { UpdatesController } from "./updates.controller.js";
import { RoutingModule } from "../routing/routing.module.js";
import { ModelMetricsController } from "./model-metrics.controller.js";
import { ServiceConnectionsController } from "./services/service-connections.controller.js";
import { ServiceConnectionsStore } from "./services/service-connections.store.js";
import { ServiceConnectionsHistory } from "./services/service-connections-history.service.js";
import { ServiceConnectionsAdapter } from "./services/service-connections.adapter.js";
import { ServiceRestartController } from "./services/service-restart.controller.js";
import { ServiceRestart } from "./services/service-restart.service.js";
import { HelperPreferencesHistory } from "./helper-preferences-history.service.js";
import { HelperModeHistory } from "./helper-mode-history.service.js";
import { HelperHotkeyHistory } from "./helper-hotkey-history.service.js";
import { ToolSwitchHistory } from "./tool-switch-history.service.js";
import { SidebarHistory } from "./sidebar-history.service.js";
import { PersonaHistoryService } from "./persona-history.service.js";
import { PersonaPreferencesHistoryService } from "./persona-preferences-history.service.js";
import { InstructionSkillHistory } from "./instruction-skill-history.service.js";
import { QuickActionsHistory } from "./quick-actions-history.service.js";
import { ToolDescriptionHistoryService } from "./tool-description-history.service.js";
import { NoteWidgetHistory } from "./note-widget-history.service.js";
import { WidgetDisplayHistory } from "./widget-display-history.service.js";
import { WallpaperHistory } from "./wallpaper-history.service.js";
import { NodeRedManagement } from "./node-red-management.service.js";
import { SkillAssistantService } from "./ai/skill-assistant.service.js";
import { PlaybooksService } from "./playbooks.service.js";
import { PublicConfigService } from "./public-config.service.js";
import { SettingsController } from "./settings.controller.js";
import { SettingsGuard } from "./settings.guard.js";
import { SkillsSource } from "./skills/skills.source.js";
import { SettingsStoreModule } from "./store/settings-store.module.js";
import { WidgetDataService } from "./widgets/widget-data.service.js";
import { WidgetsController } from "./widgets/widgets.controller.js";
import { HomeModule } from "../home/home.module.js";
import { ProxmoxModule } from "../proxmox/proxmox.module.js";
import { TermixModule } from "../integrations/termix/termix.module.js";
import { PangolinModule } from "../integrations/pangolin/pangolin.module.js";
import { ManagedTargetsAccessModule } from "./managed-targets-access.module.js";
import { ManagedTargetsAccessHistory } from "./managed-targets-access-history.service.js";
import { McpModule } from "../integrations/mcp/mcp.module.js";
import { McpStatusController } from "./mcp-status.controller.js";
import { McpManagement } from "./mcp-management.service.js";
import { StackControlController } from "./stack-control.controller.js";
import { StackControlModule } from "./stack-control.module.js";
import { UpdatesModule } from "./updates.module.js";
import { WorkspaceProjectsController } from "./workspace-projects.controller.js";
import { WorkspaceProjects } from "./workspace-projects.service.js";
import { WorkspaceCodeService } from "./workspace-code.service.js";
import { WorkspaceCodeSource } from "./workspace-code.source.js";
import { WorkspaceCodeController } from "./workspace-code.controller.js";
import { WorkspaceGitMcp } from "./workspace-git-mcp.service.js";
import { HomeAssistantAccessHistory } from "./home-assistant-access-history.service.js";

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
  imports: [
    SettingsStoreModule,
    RoutingModule,
    ConfirmationsModule,
    PlanningModule,
    HomeModule,
    ProxmoxModule,
    TermixModule,
    PangolinModule,
    ManagedTargetsAccessModule,
    McpModule,
    StackControlModule,
    UpdatesModule,
  ],
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
    NativeSkillRemovalController,
    NativePromptController,
    OmniRouteAccountsController,
    OmniRouteAccountActivationController,
    OmniRouteKeyActivationController,
    OmniRouteKeyModelAccessController,
    OmniRouteComboCreateController,
    OmniRouteComboRemovalController,
    OmniRouteComboUpdateController,
    OmniRouteComboActivationController,
    ModelRolesController,
    OmniRouteAccountRemovalController,
    OmniRouteAccountCreateController,
    OmniRouteAccountKeyUpdateController,
    FreePolicyWizardController,
    McpStatusController,
    StackControlController,
    WorkspaceProjectsController,
    WorkspaceCodeController,
  ],
  providers: [
    SettingsGuard,
    SettingsMutationsService,
    SettingsBackupService,
    ManagedTargetsAccessHistory,
    HomeAssistantAccessHistory,
    SettingsSource,
    NativeSkillModesService,
    NativeSkillRemoval,
    NativePromptService,
    NativeMemorySettingsService,
    NativeMemoryRecordsService,
    OmniRouteAccountRemoval,
    OmniRouteAccountCreate,
    OmniRouteAccountKeyUpdate,
    OmniRouteAccountActivation,
    OmniRouteActivationHistory,
    OmniRouteKeyActivation,
    OmniRouteKeyModelAccess,
    OmniRouteComboCreate,
    OmniRouteComboRemoval,
    OmniRouteComboUpdate,
    OmniRouteComboActivation,
    ModelRolesService,
    FreePolicyWizard,
    ServiceConnectionsStore,
    McpManagement,
    ServiceConnectionsHistory,
    ServiceConnectionsAdapter,
    ServiceRestart,
    HelperPreferencesHistory,
    HelperModeHistory,
    HelperHotkeyHistory,
    ToolSwitchHistory,
    SidebarHistory,
    PersonaHistoryService,
    PersonaPreferencesHistoryService,
    InstructionSkillHistory,
    QuickActionsHistory,
    ToolDescriptionHistoryService,
    NoteWidgetHistory,
    WidgetDisplayHistory,
    WallpaperHistory,
    NodeRedManagement,
    SkillsSource,
    PlaybooksService,
    PublicConfigService,
    SkillAssistantService,
    WidgetDataService,
    WorkspaceProjects,
    WorkspaceCodeService,
    WorkspaceCodeSource,
    WorkspaceGitMcp,
  ],
  exports: [PlaybooksService, PublicConfigService, SkillAssistantService],
})
export class SettingsModule {}

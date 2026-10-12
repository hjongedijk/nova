import { SettingsBackupService } from "./settings-backup.service.js";
import { MAX_BACKUP_BYTES } from "./backup-plan.js";
import { HelperPreferencesHistory } from "./helper-preferences-history.service.js";
import { HelperModeHistory } from "./helper-mode-history.service.js";
import { HelperHotkeyHistory } from "./helper-hotkey-history.service.js";
import { ToolSwitchHistory } from "./tool-switch-history.service.js";
import { SidebarHistory } from "./sidebar-history.service.js";
import { PersonaHistoryService } from "./persona-history.service.js";
import { InstructionSkillHistory } from "./instruction-skill-history.service.js";
import { QuickActionsHistory } from "./quick-actions-history.service.js";
import { ToolDescriptionHistoryService } from "./tool-description-history.service.js";
import { NoteWidgetHistory } from "./note-widget-history.service.js";
import { WidgetDisplayHistory } from "./widget-display-history.service.js";
import { WallpaperHistory } from "./wallpaper-history.service.js";
import {
  NodeRedManagement,
  projectNodeRedFlowRuns,
} from "./node-red-management.service.js";
import { SettingsMutationsService } from "./settings-mutations.service.js";
import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Optional,
  Param,
  Post,
  Put,
  UseGuards,
} from "@nestjs/common";
import type {
  PublicConfig,
  WindowsAgentStatus,
  HelperPreferences,
  SettingsBackup,
  SettingsOverview,
  Skill,
  SkillDraftResult,
  SkillRun,
  SkillSuggestion,
  SkillTestResult,
  ToolOverride,
  NoteWidget,
  Widget,
  HelperState,
  HelperSettings,
  WallpaperState,
} from "@nova/contracts";
import crypto from "node:crypto";
import { NovaConfig } from "../core/config/nova-config.js";
import { AuditService } from "../core/audit/audit.service.js";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import { ToolsService } from "../tools/tools.service.js";
import { groupTools } from "./abilities.js";
import { SkillAssistantService } from "./ai/skill-assistant.service.js";
import { PlaybooksService } from "./playbooks.service.js";
import { PublicConfigService } from "./public-config.service.js";
import { PublicRoute, SettingsGuard } from "./settings.guard.js";
import {
  BUILTIN_PANELS,
  MAX_PAGES,
  normalizeHelperPreferences,
  normalizeQuickActions,
  normalizeSidebar,
  normalizeToolOverride,
  resolveSidebar,
} from "./settings-validation.js";
import { runSkill } from "./skills/run-skill.js";
import {
  normalizeSkill,
  publicSkill,
  relevantPlaybooks,
  slugify,
  type StoredSkill,
  type StoredWebhookSkill,
  toolNameFor,
} from "./skills/skills.js";
import { SettingsStore } from "./store/settings.store.js";
import { WALLPAPER_PORT, type WallpaperPort } from "./wallpaper.port.js";
import { fetchWidget, normalizeWidget } from "./widgets/widgets.js";
import { HomeAssistantService } from "../home/home-assistant.service.js";
import { ProxmoxService } from "../proxmox/proxmox.service.js";
import { TermixService } from "../integrations/termix/termix.service.js";
import { PangolinService } from "../integrations/pangolin/pangolin.service.js";
import { ManagedTargetsAccessStore } from "./managed-targets-access.store.js";
import { ManagedTargetsAccessHistory } from "./managed-targets-access-history.service.js";
import { HomeAssistantAccessHistory } from "./home-assistant-access-history.service.js";
import { PersonaPreferencesHistoryService } from "./persona-preferences-history.service.js";
import { HouseholdProfileHistory } from "./household-profile-history.service.js";

const MAX_WIDGETS = 20;

type Body_ = Record<string, unknown> | undefined;

const skillsOf = (settings: { skills: unknown[] }) =>
  settings.skills as unknown as StoredSkill[];
const widgetsOf = (settings: { widgets: unknown[] }) =>
  settings.widgets as unknown as Widget[];

/**
 * The settings API behind the settings screen. Every change goes through the same validation
 * as an import, is written to the action log, and takes effect immediately.
 */
@Controller("settings")
@UseGuards(SettingsGuard)
export class SettingsController {
  constructor(
    private readonly settings: SettingsStore,
    private readonly audit: AuditService,
    private readonly config: NovaConfig,
    private readonly tools: ToolsService,
    private readonly publicConfig: PublicConfigService,
    private readonly assistant: SkillAssistantService,
    private readonly playbooks: PlaybooksService,
    private readonly mutations: SettingsMutationsService,
    private readonly backups: SettingsBackupService,
    private readonly helperHistory: HelperPreferencesHistory,
    private readonly helperModeHistory: HelperModeHistory,
    private readonly helperHotkeyHistory: HelperHotkeyHistory,
    private readonly toolHistory: ToolSwitchHistory,
    private readonly sidebarHistory: SidebarHistory,
    private readonly personaHistory: PersonaHistoryService,
    private readonly personaPreferencesHistory: PersonaPreferencesHistoryService,
    private readonly instructionSkillHistory: InstructionSkillHistory,
    private readonly quickActionsHistory: QuickActionsHistory,
    private readonly toolDescriptionHistory: ToolDescriptionHistoryService,
    private readonly noteWidgetHistory: NoteWidgetHistory,
    private readonly widgetDisplayHistory: WidgetDisplayHistory,
    private readonly wallpaperHistory: WallpaperHistory,
    private readonly nodeRedManagement: NodeRedManagement,
    private readonly homeAssistant: HomeAssistantService,
    private readonly proxmox: ProxmoxService,
    private readonly termix: TermixService,
    private readonly pangolin: PangolinService,
    private readonly managedTargets: ManagedTargetsAccessStore,
    private readonly managedTargetsHistory: ManagedTargetsAccessHistory,
    private readonly homeAccessHistory: HomeAssistantAccessHistory,
    private readonly householdProfileHistory: HouseholdProfileHistory,
    @Optional()
    @Inject(WALLPAPER_PORT)
    private readonly wallpaper?: WallpaperPort,
  ) {}

  private log(what: string, detail: Record<string, unknown> = {}): void {
    this.audit.record({
      sessionId: "settings",
      tool: "settings_change",
      risk: "SAFE",
      confirmation: "admin_ui",
      arguments: { what, ...detail },
      result: { ok: true },
    });
  }

  /** The home screen needs the quick actions and example phrases without any PIN. */
  @Get("public")
  @PublicRoute()
  getPublic(): PublicConfig {
    return this.publicConfig.get();
  }

  /** PIN-protected, on-demand names-only inventory. This does not enforce an access allowlist. */
  @Get("home-assistant/inventory")
  async homeAssistantInventory() {
    try {
      await this.homeAssistant.sync();
    } catch {
      throw new HttpException(
        {
          message:
            "Home Assistant reageert niet. Controleer de koppeling en probeer opnieuw.",
        },
        503,
      );
    }
    return {
      syncedAt: this.homeAssistant.syncedAt,
      areas: this.homeAssistant.areas
        .slice(0, 100)
        .map(({ area_id, name }) => ({ id: area_id, name })),
      devices: this.homeAssistant.devices.slice(0, 500).map((device) => ({
        id: device.id,
        name: device.name_by_user || device.name || device.id,
        areaId: device.area_id || null,
      })),
      entities: this.homeAssistant.entities.slice(0, 1000).map((entity) => ({
        id: entity.entity_id,
        name: entity.friendly_name || entity.entity_id,
        domain: entity.domain,
        areaId: entity.area_id || null,
        deviceId: entity.device_id || null,
      })),
    };
  }

  @Get("home-assistant/access")
  homeAssistantAccess() {
    return this.homeAssistant.accessPolicy();
  }

  @Put("home-assistant/access")
  async setHomeAssistantAccess(@Body() body: unknown) {
    try {
      await this.homeAssistant.sync();
      const before = this.homeAssistant.accessPolicy();
      const policy = this.homeAssistant.setAccessPolicy(body);
      this.homeAccessHistory.record(before, policy);
      this.log("home_assistant_access", {
        mode: policy.mode,
        areas: policy.areaIds.length,
        devices: policy.deviceIds.length,
        entities: policy.entityIds.length,
      });
      return {
        ok: true,
        policy,
        ...(this.homeAccessHistory.lastWarning
          ? { historyWarning: this.homeAccessHistory.lastWarning }
          : {}),
      };
    } catch (error) {
      throw new ValidationError([
        error instanceof Error
          ? error.message
          : "Home Assistant-toegang kon niet worden opgeslagen.",
      ]);
    }
  }

  @Get("home-assistant/access/history")
  homeAssistantAccessHistory() {
    return this.homeAccessHistory.list();
  }

  @Post("home-assistant/access/history/:id/prepare-rollback")
  @HttpCode(200)
  prepareHomeAssistantAccessRollback(@Param("id") id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige wijziging."]);
    return this.homeAccessHistory.prepareRollback(id);
  }

  @Post("home-assistant/access/history/confirm-rollback")
  @HttpCode(200)
  confirmHomeAssistantAccessRollback(@Body() body: unknown) {
    if (
      !body ||
      typeof body !== "object" ||
      Array.isArray(body) ||
      Object.keys(body).some(
        (key) => !["sessionId", "confirmationId", "approve"].includes(key),
      )
    )
      throw new ValidationError([
        "Controleer de wijziging en bevestig opnieuw.",
      ]);
    const value = body as Record<string, unknown>;
    if (
      typeof value.sessionId !== "string" ||
      !/^settings-ha-access-history:[0-9a-f-]{36}$/i.test(value.sessionId) ||
      typeof value.confirmationId !== "string" ||
      !/^[0-9a-f-]{36}$/i.test(value.confirmationId) ||
      typeof value.approve !== "boolean"
    )
      throw new ValidationError([
        "Controleer de wijziging en bevestig opnieuw.",
      ]);
    return this.homeAccessHistory.confirm(
      value.sessionId,
      value.confirmationId,
      value.approve,
    );
  }

  /** PIN-protected on-demand target names; informational only, not an access allowlist. */
  @Get("managed-targets/inventory")
  async managedTargetInventory() {
    const genericError = { error: "Overzicht niet beschikbaar." };
    const object = (value: unknown): Record<string, unknown> =>
      value && typeof value === "object" && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {};
    const nameRows = (value: unknown, keys: string[]) => {
      if (!Array.isArray(value)) return [];
      return value.slice(0, 200).flatMap((item) => {
        const row = object(item);
        const name = keys
          .map((key) => row[key])
          .find((entry) => typeof entry === "string" && entry.length > 0);
        const id = row.id ?? row.vmid ?? row.node;
        return typeof name === "string"
          ? [
              {
                ...(typeof id === "string" || typeof id === "number"
                  ? { id: String(id).slice(0, 100) }
                  : {}),
                name: sanitize(name).slice(0, 200),
              },
            ]
          : [];
      });
    };
    const [proxmox, termix, pangolin] = await Promise.all([
      (async () => {
        if (!this.proxmox.configured)
          return { configured: false, nodes: [], guests: [] };
        try {
          const [nodes, guests] = await Promise.all([
            this.proxmox.rawNodes(),
            this.proxmox.resources("vm"),
          ]);
          return {
            configured: true,
            nodes: nameRows(nodes, ["node", "name"]),
            guests: guests.slice(0, 200).flatMap((guest) =>
              typeof guest.node === "string" &&
              Number.isSafeInteger(guest.vmid) &&
              typeof guest.name === "string"
                ? [
                    {
                      id: `${guest.node}/${guest.vmid}`,
                      name: sanitize(guest.name).slice(0, 200),
                    },
                  ]
                : [],
            ),
          };
        } catch {
          return { configured: true, ...genericError, nodes: [], guests: [] };
        }
      })(),
      (async () => {
        if (!this.termix.configured) return { configured: false, hosts: [] };
        try {
          const hosts = await this.termix.listHosts();
          return { configured: true, hosts: nameRows(hosts, ["name"]) };
        } catch {
          return { configured: true, ...genericError, hosts: [] };
        }
      })(),
      (async () => {
        if (!this.pangolin.configured)
          return { configured: false, sites: [], resources: [] };
        try {
          const [sites, resources] = await Promise.all([
            this.pangolin.listTargets("pangolin_sites"),
            this.pangolin.listTargets("pangolin_resources"),
          ]);
          const list = (result: unknown, key: string) => {
            const data = object(result);
            return nameRows(data[key], ["name", "label"]);
          };
          return {
            configured: true,
            sites: list(sites, "sites"),
            resources: list(resources, "resources"),
          };
        } catch {
          return {
            configured: true,
            ...genericError,
            sites: [],
            resources: [],
          };
        }
      })(),
    ]);
    return { checkedAt: new Date().toISOString(), proxmox, termix, pangolin };
  }

  @Get("managed-targets/access")
  managedTargetsAccess() {
    return this.managedTargets.get();
  }

  @Get("managed-targets/access/history")
  managedTargetsAccessHistory() {
    return this.managedTargetsHistory.list();
  }

  @Post("managed-targets/access/history/:id/prepare-rollback")
  @HttpCode(200)
  prepareManagedTargetsAccessRollback(@Param("id") id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige wijziging."]);
    return this.managedTargetsHistory.prepareRollback(id);
  }

  @Post("managed-targets/access/history/confirm-rollback")
  @HttpCode(200)
  confirmManagedTargetsAccessRollback(@Body() body: unknown) {
    if (!body || typeof body !== "object" || Array.isArray(body))
      throw new ValidationError(["Ongeldige bevestiging."]);
    const input = body as Record<string, unknown>;
    if (
      Object.keys(input).some(
        (key) => !["sessionId", "confirmationId", "approve"].includes(key),
      ) ||
      typeof input.sessionId !== "string" ||
      typeof input.confirmationId !== "string" ||
      typeof input.approve !== "boolean"
    )
      throw new ValidationError(["Ongeldige bevestiging."]);
    return this.managedTargetsHistory.confirm(
      input.sessionId,
      input.confirmationId,
      input.approve,
    );
  }

  @Put("managed-targets/access")
  async setManagedTargetsAccess(@Body() body: unknown) {
    const inventory = await this.managedTargetInventory();
    const value = inventory as Record<string, unknown>;
    const rows = (service: string, key: string) => {
      const data = value[service] as Record<string, unknown> | undefined;
      const items = data?.[key];
      return new Set(
        Array.isArray(items)
          ? items.flatMap((item) =>
              item &&
              typeof item === "object" &&
              typeof (item as { id?: unknown }).id === "string"
                ? [(item as { id: string }).id]
                : [],
            )
          : [],
      );
    };
    const current = this.managedTargets.get();
    const known: Record<string, Set<string>> = {
      proxmoxNodeIds: rows("proxmox", "nodes"),
      proxmoxGuestIds: rows("proxmox", "guests"),
      termixHostIds: rows("termix", "hosts"),
      pangolinSiteIds: rows("pangolin", "sites"),
      pangolinResourceIds: rows("pangolin", "resources"),
    };
    for (const key of [
      "proxmoxNodeIds",
      "proxmoxGuestIds",
      "termixHostIds",
      "pangolinSiteIds",
      "pangolinResourceIds",
    ] as const)
      current[key].forEach((id) => known[key]!.add(id));
    const policy = this.managedTargets.set(body, known);
    this.managedTargetsHistory.record(current, policy);
    this.log("managed_targets_access", {
      mode: policy.mode,
      proxmoxNodes: policy.proxmoxNodeIds.length,
      proxmoxGuests: policy.proxmoxGuestIds.length,
      termixHosts: policy.termixHostIds.length,
      pangolinSites: policy.pangolinSiteIds.length,
      pangolinResources: policy.pangolinResourceIds.length,
    });
    return {
      ok: true,
      policy,
      ...(this.managedTargetsHistory.lastWarning
        ? { historyWarning: this.managedTargetsHistory.lastWarning }
        : {}),
    };
  }

  @Get()
  overview(): SettingsOverview {
    this.settings.backupBeforeSettingsPage();
    const settings = this.settings.get();
    const tools = this.tools.list();
    return {
      persona: settings.persona,
      personaStyle: settings.personaStyle,
      personaProfile: settings.personaProfile,
      householdProfiles: settings.householdProfiles,
      activeHouseholdProfileId: settings.activeHouseholdProfileId,
      standingApprovals: settings.standingApprovals.map(
        ({ id, tool, scope, createdAt }) => ({ id, tool, scope, createdAt }),
      ),
      quickActions: this.settings.quickActions(),
      quickActionsAreDefault: settings.quickActions === null,
      skills: skillsOf(settings).map(publicSkill),
      widgets: widgetsOf(settings),
      sidebar: resolveSidebar(settings),
      builtinPanels: BUILTIN_PANELS,
      maxPages: MAX_PAGES,
      abilities: groupTools(tools),
      tools,
      pinRequired: Boolean(this.config.adminPin),
    };
  }

  @Put("persona")
  setPersona(@Body() body: Body_) {
    return this.mutations.setPersona(body?.text);
  }

  @Put("persona/style")
  setPersonaStyle(@Body() body: Body_) {
    return this.mutations.setPersonaStyle(body?.style);
  }

  @Put("persona/profile")
  setPersonaProfile(@Body() body: Body_) {
    return this.mutations.setPersonaProfile(body?.profile);
  }

  @Put("household-profiles")
  setHouseholdProfiles(@Body() body: Body_) {
    return this.mutations.setHouseholdProfiles(
      body?.profiles,
      body?.activeProfileId,
    );
  }

  @Get("household-profiles/history")
  householdProfileHistoryList() {
    return this.householdProfileHistory.list();
  }

  @Post("household-profiles/history/:id/rollback")
  @HttpCode(200)
  rollbackHouseholdProfile(@Param("id") id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige profielwissel."]);
    return this.householdProfileHistory.rollback(id);
  }

  @Get("persona/preferences/history")
  personaPreferencesHistoryList() {
    return this.personaPreferencesHistory.list();
  }

  @Post("persona/preferences/history/:id/rollback")
  @HttpCode(200)
  rollbackPersonaPreferences(@Param("id") id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige profielwijziging."]);
    return this.personaPreferencesHistory.rollback(id);
  }

  @Get("persona/history")
  personaHistoryList() {
    return this.personaHistory.list();
  }

  @Post("persona/history/:id/rollback")
  @HttpCode(200)
  rollbackPersona(@Param("id") id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige wijziging."]);
    return this.personaHistory.rollback(id);
  }

  @Put("quick-actions")
  setQuickActions(@Body() body: Body_) {
    const before = this.quickActionsHistory.current();
    const items =
      body?.reset === true ? null : normalizeQuickActions(body?.items);
    this.settings.update((settings) => void (settings.quickActions = items));
    const quickActions = items ?? this.settings.quickActions();
    this.quickActionsHistory.record(before, this.quickActionsHistory.current());
    this.log("quick-actions", { count: items?.length ?? "default" });
    return {
      ok: true,
      quickActions,
      ...(this.quickActionsHistory.lastWarning
        ? { historyWarning: this.quickActionsHistory.lastWarning }
        : {}),
    };
  }

  @Get("quick-actions/history")
  quickActionsHistoryList() {
    return this.quickActionsHistory.list();
  }

  @Post("quick-actions/history/:id/rollback")
  @HttpCode(200)
  rollbackQuickActions(@Param("id") id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige wijziging."]);
    return this.quickActionsHistory.rollback(id);
  }

  @Put("tools/:name")
  setTool(
    @Param("name") name: string,
    @Body() body: Body_,
  ): { ok: true; override: ToolOverride; historyWarning?: string } {
    const override = normalizeToolOverride(name, body);
    const beforeDescription =
      this.settings.get().toolOverrides[name]?.description ?? null;
    const before = this.tools
      .list()
      .find((tool) => tool.name === name)?.enabled;
    this.settings.update((settings) => {
      if (Object.keys(override).length) settings.toolOverrides[name] = override;
      else delete settings.toolOverrides[name];
    });
    const afterDescription =
      this.settings.get().toolOverrides[name]?.description ?? null;
    this.toolDescriptionHistory.record(
      name,
      beforeDescription,
      afterDescription,
    );
    const after = this.tools.list().find((tool) => tool.name === name)?.enabled;
    if (before !== undefined && after !== undefined)
      this.toolHistory.record({ [name]: before }, { [name]: after });
    this.log("tool", {
      tool: name,
      ...(override.enabled === false ? { enabled: false } : {}),
      ...(override.description !== undefined
        ? { descriptionLength: override.description.length }
        : {}),
    });
    return {
      ok: true,
      override,
      ...(this.toolDescriptionHistory.lastWarning
        ? { historyWarning: this.toolDescriptionHistory.lastWarning }
        : {}),
    };
  }

  @Delete("tools/:name")
  resetTool(@Param("name") name: string): {
    ok: true;
    historyWarning?: string;
  } {
    normalizeToolOverride(name, {});
    const beforeDescription =
      this.settings.get().toolOverrides[name]?.description ?? null;
    const before = this.tools
      .list()
      .find((tool) => tool.name === name)?.enabled;
    this.settings.update(
      (settings) => void delete settings.toolOverrides[name],
    );
    this.toolDescriptionHistory.record(name, beforeDescription, null);
    const after = this.tools.list().find((tool) => tool.name === name)?.enabled;
    if (before !== undefined && after !== undefined)
      this.toolHistory.record({ [name]: before }, { [name]: after });
    this.log("tool-reset", { tool: name });
    return {
      ok: true,
      ...(this.toolDescriptionHistory.lastWarning
        ? { historyWarning: this.toolDescriptionHistory.lastWarning }
        : {}),
    };
  }

  @Get("tools/:name/description-history")
  toolDescriptionHistoryList(@Param("name") name: string) {
    this.toolDescriptionHistory.current(name);
    return this.toolDescriptionHistory.list(name);
  }

  @Post("tools/:name/description-history/:id/rollback")
  @HttpCode(200)
  rollbackToolDescription(
    @Param("name") name: string,
    @Param("id") id: string,
  ) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige wijziging."]);
    const revision = this.toolDescriptionHistory
      .list(name)
      .revisions.find((row) => row.id === id);
    if (!revision)
      throw new NotFoundException("Deze wijziging is niet meer beschikbaar.");
    return this.toolDescriptionHistory.rollback(id);
  }

  /** Switch a whole ability on or off: every tool in it. */
  @Put("abilities/:id")
  setAbility(
    @Param("id") id: string,
    @Body() body: Body_,
  ): { ok: true; auditWarning?: string } {
    if (typeof body?.enabled !== "boolean")
      throw new ValidationError(["Kies aan of uit."]);
    const enabled = body.enabled;
    const group = groupTools(this.tools.list()).find((item) => item.id === id);
    if (!group) throw new NotFoundException("Dat onderdeel bestaat niet.");
    const before = this.toolHistory.current(group.tools);
    this.settings.update((settings) => {
      for (const name of group.tools) {
        const current = { ...settings.toolOverrides[name] };
        if (enabled) delete current.enabled;
        else current.enabled = false;
        if (Object.keys(current).length) settings.toolOverrides[name] = current;
        else delete settings.toolOverrides[name];
      }
    });
    const after = this.toolHistory.current(group.tools);
    this.toolHistory.record(before, after);
    this.log("ability", {
      ability: group.id,
      enabled,
      tools: group.tools.length,
    });
    return {
      ok: true,
      ...(this.toolHistory.lastWarning
        ? { auditWarning: this.toolHistory.lastWarning }
        : {}),
    };
  }

  @Get("tools/history")
  toolSwitchHistory() {
    return this.toolHistory.list();
  }

  @Post("tools/history/:id/rollback")
  @HttpCode(200)
  rollbackToolSwitches(@Param("id") id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige wijziging."]);
    return this.toolHistory.rollback(id);
  }

  @Get("sidebar/history")
  sidebarHistoryList() {
    return this.sidebarHistory.list();
  }

  @Post("sidebar/history/:id/rollback")
  @HttpCode(200)
  rollbackSidebar(@Param("id") id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige wijziging."]);
    return this.sidebarHistory.rollback(id);
  }

  /* ---------- skills ---------- */

  /** From a person's own words to a draft skill. Nothing is saved. */
  @Post("skills/draft")
  @HttpCode(200)
  async draft(@Body() body: Body_): Promise<{ ok: true } & SkillDraftResult> {
    return {
      ok: true,
      ...(await this.assistant.draftSkill({ description: body?.description })),
    };
  }

  @Post("skills")
  create(@Body() body: unknown): { ok: true; skill: Skill } {
    return this.mutations.createSkill(body);
  }

  @Put("skills/:id")
  update(
    @Param("id") id: string,
    @Body() body: unknown,
  ): { ok: true; skill: Skill } {
    return this.mutations.updateSkill(id, body);
  }

  @Delete("skills/:id")
  remove(@Param("id") id: string): { ok: true; historyWarning?: string } {
    const existing = skillsOf(this.settings.get()).find(
      (item) => item.id === id,
    );
    if (!existing) throw new NotFoundException("Die vaardigheid bestaat niet.");
    this.settings.update((settings) => {
      settings.skills = settings.skills.filter(
        (item) => (item as StoredSkill).id !== existing.id,
      );
      delete settings.toolOverrides[toolNameFor(existing)];
    });
    let historyWarning: string | undefined;
    if (existing.type === "instruction") {
      try {
        this.instructionSkillHistory.forget(existing.id);
      } catch {
        historyWarning =
          "De vaardigheid is verwijderd, maar de private wijzigingsgeschiedenis kon niet worden gewist.";
      }
    }
    this.log("skill-deleted", { skill: existing.id });
    return { ok: true, ...(historyWarning ? { historyWarning } : {}) };
  }

  /** Try a draft before saving it. A webhook really runs; an instruction only reports whether it would be picked. */
  @Post("skills/test")
  @HttpCode(200)
  async test(@Body() body: Body_): Promise<SkillTestResult> {
    const draft = body?.skill as Record<string, unknown> | undefined;
    const stored = skillsOf(this.settings.get()).find(
      (item) => item.id === slugify(draft?.name ?? ""),
    );
    const skill = normalizeSkill(draft, {
      existing: stored && stored.type === draft?.type ? stored : undefined,
    });
    if (skill.type === "instruction") {
      const phrase = String(body?.phrase ?? "").slice(0, 300);
      const matched =
        relevantPlaybooks(phrase, [{ ...skill, enabled: true }]).length > 0;
      return { ok: true, type: "instruction", matched, phrase };
    }
    const outcome = await runSkill(
      skill as StoredWebhookSkill,
      (body?.args ?? {}) as Record<string, unknown>,
    );
    this.log("skill-tested", { skill: skill.id, ok: outcome.ok });
    return { type: "webhook", ...sanitize(outcome) };
  }

  @Get("skills/:id/runs")
  runs(@Param("id") id: string): { runs: SkillRun[] } {
    const tool = `skill_${id}`;
    const runs = this.audit
      .read(500)
      .filter((entry) => entry.tool === tool)
      .slice(0, 20)
      .map((entry) => {
        const result = entry.result as
          { ok?: boolean; error?: string } | undefined;
        return {
          at: entry.timestamp,
          ok: result?.ok === true,
          error: result?.error
            ? /^HTTP [45]\d\d$/.test(result.error)
              ? result.error
              : "De aanroep is mislukt."
            : null,
          arguments: (entry.arguments ?? {}) as Record<string, unknown>,
        };
      });
    return { runs };
  }

  @Get("skills/:id/versions")
  skillVersions(@Param("id") id: string): {
    currentVersion: number;
    scannedEntries: number;
    truncated: boolean;
    versions: { version: number; at: string; action: "created" | "updated" }[];
  } {
    const skill = skillsOf(this.settings.get()).find((item) => item.id === id);
    if (!skill) throw new NotFoundException("Die vaardigheid bestaat niet.");
    const entries = this.audit.read(500);
    const versions = entries.flatMap((entry) => {
      if (!entry || typeof entry !== "object" || Array.isArray(entry))
        return [];
      const args = entry.arguments;
      if (!args || typeof args !== "object" || Array.isArray(args)) return [];
      const row = args as Record<string, unknown>;
      const action: "created" | "updated" | null =
        row.what === "skill-created"
          ? "created"
          : row.what === "skill-updated"
            ? "updated"
            : null;
      const version = row.version ?? (action === "created" ? 1 : undefined);
      const timestamp =
        typeof entry.timestamp === "string" ? new Date(entry.timestamp) : null;
      if (
        entry.tool !== "settings_change" ||
        row.skill !== id ||
        !action ||
        typeof version !== "number" ||
        !Number.isSafeInteger(version) ||
        version < 1 ||
        !timestamp ||
        !Number.isFinite(timestamp.getTime()) ||
        timestamp.toISOString() !== entry.timestamp
      )
        return [];
      return [{ version, at: timestamp.toISOString(), action }];
    });
    return {
      currentVersion: Number.isSafeInteger(skill.version) ? skill.version : 1,
      scannedEntries: entries.length,
      truncated: entries.length === 500 || versions.length > 20,
      versions: versions.slice(0, 20).reverse(),
    };
  }

  @Get("skills/:id/content-history")
  instructionSkillContentHistory(@Param("id") id: string) {
    return this.instructionSkillHistory.list(id);
  }

  @Post("skills/:id/content-history/:revision/rollback")
  @HttpCode(200)
  rollbackInstructionSkill(
    @Param("id") id: string,
    @Param("revision") revision: string,
  ) {
    return this.instructionSkillHistory.rollback(id, revision);
  }

  /** NOVA proposes a better version of a skill. Nothing is saved: the screen shows the proposal. */
  @Post("skills/improve")
  @HttpCode(200)
  async improve(@Body() body: Body_): Promise<{ ok: true } & SkillSuggestion> {
    const draft = body?.skill as Record<string, unknown> | undefined;
    if (!draft || typeof draft !== "object")
      throw new ValidationError([
        "Geef de vaardigheid mee die verbeterd moet worden.",
      ]);
    const tool = `skill_${slugify(draft.name ?? "")}`;
    const runs = this.audit
      .read(500)
      .filter((entry) => entry.tool === tool)
      .slice(0, 8)
      .map((entry) => {
        const result = entry.result as
          { ok?: boolean; error?: string } | undefined;
        return {
          ok: result?.ok === true,
          error: result?.error ?? null,
          arguments: entry.arguments ?? {},
        };
      });
    const suggestion = await this.assistant.improveSkill({
      draft: sanitize(draft),
      goal: String(body?.goal ?? "").slice(0, 400),
      runs,
    });
    return { ok: true, ...suggestion };
  }

  /* ---------- sidebar panels ---------- */

  private webhookIds(settings: { skills: unknown[] }): string[] {
    return skillsOf(settings)
      .filter((skill) => skill.type === "webhook")
      .map((skill) => skill.id);
  }

  @Post("widgets")
  createWidget(@Body() body: unknown): {
    widget: Widget;
    historyWarning?: string;
  } {
    this.noteWidgetHistory.lastWarning = undefined;
    let widget!: Widget;
    this.settings.update((settings) => {
      if (settings.widgets.length >= MAX_WIDGETS)
        throw new ValidationError([`Maximaal ${MAX_WIDGETS} panelen.`]);
      widget = normalizeWidget(body, {
        takenIds: widgetsOf(settings).map((item) => slugify(item.title)),
        skillIds: this.webhookIds(settings),
      });
      // A deleted widget must never reclaim an old private-history namespace,
      // even when pruning its history file fails.
      if (
        widget.type === "note" ||
        widget.type === "value" ||
        widget.type === "list"
      )
        widget = {
          ...widget,
          id: `${widget.id.slice(0, 15)}_${crypto.randomBytes(12).toString("hex")}`,
        };
      settings.widgets.push(widget as never);
    });
    if (widget.type === "note") this.noteWidgetHistory.recordCreated(widget);
    this.log("widget_created", { id: widget.id, type: widget.type });
    return {
      widget,
      ...(this.noteWidgetHistory.lastWarning
        ? { historyWarning: this.noteWidgetHistory.lastWarning }
        : {}),
    };
  }

  /** Try a data panel before saving it: shows what it would display. */
  @Post("widgets/preview")
  @HttpCode(200)
  async previewWidget(@Body() body: Body_) {
    const settings = this.settings.get();
    const widget = normalizeWidget(
      { ...body, title: body?.title || "Voorbeeld" },
      { takenIds: [], skillIds: this.webhookIds(settings) },
    );
    if (!("source" in widget))
      throw new ValidationError(["Dit soort paneel heeft geen gegevens."]);
    return { data: await fetchWidget(widget) };
  }

  @Put("widgets/:id")
  updateWidget(
    @Param("id") id: string,
    @Body() body: unknown,
  ): { widget: Widget; historyWarning?: string } {
    let widget!: Widget;
    let beforeNote: NoteWidget | undefined;
    let beforeDisplay: Widget | undefined;
    this.noteWidgetHistory.lastWarning = undefined;
    this.widgetDisplayHistory.lastWarning = undefined;
    this.settings.update((settings) => {
      const index = widgetsOf(settings).findIndex((item) => item.id === id);
      if (index < 0) throw new ValidationError(["Dit paneel bestaat niet."]);
      const previous = widgetsOf(settings)[index];
      beforeDisplay = previous;
      if (previous?.type === "note") beforeNote = structuredClone(previous);
      widget = normalizeWidget(body, {
        existing: previous,
        skillIds: this.webhookIds(settings),
      });
      settings.widgets[index] = widget as never;
    });
    if (beforeNote && widget.type === "note")
      this.noteWidgetHistory.record(id, beforeNote, widget);
    if (
      beforeDisplay &&
      (beforeDisplay.type === "value" || beforeDisplay.type === "list") &&
      widget.type === beforeDisplay.type
    )
      this.widgetDisplayHistory.record(id, beforeDisplay, widget);
    this.log("widget_updated", { id: widget.id });
    return {
      widget,
      ...(this.noteWidgetHistory.lastWarning
        ? { historyWarning: this.noteWidgetHistory.lastWarning }
        : this.widgetDisplayHistory.lastWarning
          ? { historyWarning: this.widgetDisplayHistory.lastWarning }
          : {}),
    };
  }

  @Get("widgets/:id/history")
  noteWidgetHistoryList(@Param("id") id: string) {
    const widget = widgetsOf(this.settings.get()).find(
      (item) => item.id === id,
    );
    if (!widget || widget.type !== "note")
      throw new ValidationError(["Deze notitie bestaat niet."]);
    return this.noteWidgetHistory.list(id);
  }

  @Post("widgets/:id/history/:revision/rollback")
  @HttpCode(200)
  noteWidgetHistoryRollback(
    @Param("id") id: string,
    @Param("revision") revision: string,
  ) {
    return this.noteWidgetHistory.rollback(id, revision);
  }

  @Get("widgets/:id/display-history")
  widgetDisplayHistoryList(@Param("id") id: string) {
    const widget = widgetsOf(this.settings.get()).find(
      (item) => item.id === id,
    );
    if (!widget || (widget.type !== "value" && widget.type !== "list"))
      throw new ValidationError(["Dit waarde- of lijstpaneel bestaat niet."]);
    return this.widgetDisplayHistory.list(id);
  }

  @Post("widgets/:id/display-history/:revision/rollback")
  @HttpCode(200)
  widgetDisplayHistoryRollback(
    @Param("id") id: string,
    @Param("revision") revision: string,
  ) {
    return this.widgetDisplayHistory.rollback(id, revision);
  }

  @Delete("widgets/:id")
  deleteWidget(@Param("id") id: string): { ok: true; historyWarning?: string } {
    const existing = widgetsOf(this.settings.get()).find(
      (item) => item.id === id,
    );
    this.settings.update((settings) => {
      const before = settings.widgets.length;
      settings.widgets = widgetsOf(settings).filter(
        (item) => item.id !== id,
      ) as never[];
      if (settings.widgets.length === before)
        throw new ValidationError(["Dit paneel bestaat niet."]);
      if (settings.sidebar)
        settings.sidebar.items = settings.sidebar.items.filter(
          (item) => item.id !== `w:${id}`,
        );
    });
    let historyWarning: string | undefined;
    if (existing?.type === "note") {
      try {
        this.noteWidgetHistory.forget(id);
      } catch {
        historyWarning =
          "De notitie is verwijderd, maar de oude wijzigingsgeschiedenis kon niet worden gewist.";
      }
    }
    if (existing?.type === "value" || existing?.type === "list") {
      try {
        this.widgetDisplayHistory.forget(id);
      } catch {
        historyWarning =
          "Het paneel is verwijderd, maar de oude wijzigingsgeschiedenis kon niet worden gewist.";
      }
    }
    this.log("widget_deleted", { id });
    return { ok: true, ...(historyWarning ? { historyWarning } : {}) };
  }

  @Put("sidebar")
  setSidebar(@Body() body: Body_) {
    const before = resolveSidebar(this.settings.get());
    this.settings.update((settings) => {
      settings.sidebar =
        body?.reset === true
          ? null
          : {
              items: normalizeSidebar(body?.items, settings) as never[],
            };
    });
    this.sidebarHistory.record(before, resolveSidebar(this.settings.get()));
    this.log("sidebar_changed", { reset: body?.reset === true });
    return {
      sidebar: resolveSidebar(this.settings.get()),
      ...(this.sidebarHistory.lastWarning
        ? { auditWarning: this.sidebarHistory.lastWarning }
        : {}),
    };
  }

  /* ---------- wallpaper on the Windows PC, through the Windows agent ---------- */

  @Get("wallpaper")
  async getWallpaper(): Promise<WallpaperState> {
    if (!this.wallpaper?.configured)
      return { available: false, reason: "no-agent" };
    const outcome = await this.wallpaper.displays();
    if (!outcome.ok)
      return {
        available: false,
        reason: /oud/.test(outcome.error) ? "old-agent" : "unreachable",
        error: outcome.error,
      };
    return {
      available: true,
      displays: outcome.displays,
      ...(outcome.mode ? { mode: outcome.mode } : {}),
      ...(outcome.helperDisplay !== undefined
        ? { helperDisplay: outcome.helperDisplay }
        : {}),
    };
  }

  @Post("wallpaper")
  @HttpCode(200)
  async setWallpaper(@Body() body: Body_): Promise<WallpaperState> {
    const mode = body?.mode;
    const display = Number(body?.display);
    if (mode !== "full" && mode !== "sphere" && mode !== "off")
      throw new ValidationError(["Kies volledig, alleen de bol of uit."]);
    if (!Number.isInteger(display) || display < 0 || display > 8)
      throw new ValidationError(["Kies een beeldscherm."]);
    if (!this.wallpaper?.configured)
      throw new ValidationError(["Er is geen Windows-agent ingesteld."]);
    const current = await this.wallpaper.displays();
    if (!current.ok) throw new ValidationError([current.error]);
    const affected =
      display === 0
        ? current.displays
        : current.displays.filter((screen) => screen.index === display);
    if (!affected.length)
      throw new ValidationError(["Dit beeldscherm bestaat niet meer."]);
    const before = affected.map((screen) => ({
      display: screen.index,
      mode: screen.mode,
    }));
    const outcome = await this.wallpaper.setWallpaper(display, mode);
    if (!outcome.ok) throw new ValidationError([outcome.error]);
    for (const item of before)
      this.wallpaperHistory.record(item.display, item.mode, mode);
    this.log("wallpaper", { display, mode });
    return {
      available: true,
      displays: outcome.displays,
      ...(this.wallpaperHistory.lastWarning
        ? { historyWarning: this.wallpaperHistory.lastWarning }
        : {}),
    };
  }

  @Get("wallpaper/history")
  wallpaperHistoryList() {
    return this.wallpaperHistory.list();
  }

  @Post("wallpaper/history/:id/rollback")
  @HttpCode(200)
  async rollbackWallpaper(@Param("id") id: string): Promise<WallpaperState> {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige wijziging."]);
    const revision = this.wallpaperHistory.find(id);
    if (!revision)
      throw new ValidationError(["Deze wijziging is niet meer beschikbaar."]);
    if (!this.wallpaper?.configured)
      throw new ValidationError(["Er is geen Windows-agent ingesteld."]);
    const current = await this.wallpaper.displays();
    if (!current.ok) throw new ValidationError([current.error]);
    const screen = current.displays.find(
      (item) => item.index === revision.display,
    );
    if (!screen || screen.mode !== revision.after)
      throw new ValidationError([
        "Dit beeldscherm is daarna gewijzigd. Terugdraaien is afgebroken.",
      ]);
    const outcome = await this.wallpaper.setWallpaper(
      revision.display,
      revision.before,
    );
    if (!outcome.ok) throw new ValidationError([outcome.error]);
    this.wallpaperHistory.record(
      revision.display,
      revision.after,
      revision.before,
      id,
    );
    return {
      available: true,
      displays: outcome.displays,
      ...(this.wallpaperHistory.lastWarning
        ? { historyWarning: this.wallpaperHistory.lastWarning }
        : {}),
    };
  }

  @Get("node-red/flows")
  async listNodeRedFlows() {
    const inventory = await this.nodeRedManagement.listFlows();
    const flowTools = this.tools
      .list()
      .filter((tool) => tool.enabled)
      .map((tool) => tool.name);
    return {
      ...inventory,
      flows: projectNodeRedFlowRuns(inventory.flows, this.audit.read(500)).map(
        (flow) => ({
          ...flow,
          runnableFlowId: flowTools.includes("node_red_flow")
            ? this.nodeRedManagement.runnableFlowId(flow.id)
            : null,
          manageable:
            flowTools.includes("node_red_flow_state") &&
            this.nodeRedManagement.canSetFlowEnabled(flow.id),
          templates: flowTools.includes("node_red_flow_create")
            ? this.nodeRedManagement.availableTemplates(flow.id)
            : [],
        }),
      ),
      editorUrl: this.nodeRedManagement.editorUrl(),
    };
  }

  /* ---------- the helper overlay on the Windows PC ---------- */

  /** The saved choice, and what the agent reports it is running. */
  @Get("helper")
  async getHelper(): Promise<HelperState> {
    return {
      settings: this.settings.get().helper,
      desktop: await this.getWallpaper(),
    };
  }

  /**
   * Save the choice (wallpaper, helper or both, and the helper's display) and apply it on the PC. The choice is
   * kept when the PC cannot be reached, so it is not lost while the PC is off; the answer says whether it was applied.
   */
  @Post("helper")
  @HttpCode(200)
  async setHelper(@Body() body: Body_): Promise<HelperState> {
    const mode = body?.mode;
    const display = Number(body?.display ?? 0);
    if (mode !== "wallpaper" && mode !== "helper" && mode !== "both")
      throw new ValidationError(["Kies achtergrond, helper of beide."]);
    if (!Number.isInteger(display) || display < 0 || display > 8)
      throw new ValidationError(["Kies een beeldscherm."]);
    const before = this.settings.get().helper;
    const after: HelperSettings = { mode, display };
    this.settings.update((next) => {
      next.helper = { mode, display };
    });
    this.helperModeHistory.record(before, after);
    this.log("helper", { mode, display });
    return this.applyHelperMode(after, this.helperModeHistory.lastWarning);
  }

  private async applyHelperMode(
    settings: HelperSettings,
    historyWarning?: string,
  ): Promise<HelperState> {
    const { mode, display } = settings;
    if (!this.wallpaper?.configured)
      return {
        settings: { mode, display },
        desktop: { available: false, reason: "no-agent" },
        applied: false,
        error: "Er is geen Windows-agent ingesteld.",
        ...(historyWarning ? { historyWarning } : {}),
      };
    const outcome = await this.wallpaper.setMode(mode, display);
    if (!outcome.ok)
      return {
        settings: { mode, display },
        desktop: await this.getWallpaper(),
        applied: false,
        error: outcome.error,
        ...(historyWarning ? { historyWarning } : {}),
      };
    return {
      settings: { mode, display },
      desktop: {
        available: true,
        displays: outcome.displays,
        ...(outcome.mode ? { mode: outcome.mode } : {}),
        ...(outcome.helperDisplay !== undefined
          ? { helperDisplay: outcome.helperDisplay }
          : {}),
      },
      applied: true,
      ...(historyWarning ? { historyWarning } : {}),
    };
  }

  @Get("helper/history")
  getHelperModeHistory() {
    return this.helperModeHistory.list();
  }

  @Post("helper/history/:id/rollback")
  @HttpCode(200)
  async rollbackHelperMode(@Param("id") id: string): Promise<HelperState> {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige wijziging."]);
    const restored = this.helperModeHistory.rollback(id);
    this.log("helper_mode_rollback", { revision: id });
    return this.applyHelperMode(restored.settings, restored.auditWarning);
  }

  /**
   * The helper page asks for its window to grow (an answer, a question to confirm) or shrink back to the pill.
   * Open like the public list: the page has no PIN, and all this can do is resize NOVA's own helper window.
   */
  @Post("helper/size")
  @PublicRoute()
  @HttpCode(200)
  async helperSize(@Body() body: Body_): Promise<{ ok: boolean }> {
    const views = [
      "compact",
      "overview",
      "chat",
      "notifications",
      "weather",
      "lists",
      "confirmation",
    ] as const;
    const view = views.find((value) => value === body?.view);
    if (
      (body?.view !== undefined && !view) ||
      (!view && typeof body?.expanded !== "boolean")
    )
      throw new ValidationError([
        "Kies compact, overview, chat of confirmation.",
      ]);
    for (const key of ["hidden", "reducedMotion"])
      if (body?.[key] !== undefined && typeof body[key] !== "boolean")
        throw new ValidationError([`${key} moet true of false zijn.`]);
    if (!this.wallpaper?.configured) return { ok: false };
    const outcome = await this.wallpaper.helperSize(
      view ? view !== "compact" : (body?.expanded as boolean),
      view
        ? {
            view,
            hidden: body?.hidden === true,
            reducedMotion: body?.reducedMotion === true,
          }
        : undefined,
    );
    return { ok: outcome.ok };
  }

  @Get("helper/preferences")
  @PublicRoute()
  getHelperPreferences(): HelperPreferences {
    return normalizeHelperPreferences({
      ...this.settings.get().helperPreferences,
    });
  }

  @Put("helper/preferences")
  saveHelperPreferences(@Body() body: Body_): {
    ok: true;
    preferences: HelperPreferences;
    auditWarning?: string;
  } {
    const preferences = normalizeHelperPreferences(body);
    const before = normalizeHelperPreferences(
      this.settings.get().helperPreferences as unknown as Record<
        string,
        unknown
      >,
    );
    this.log(
      "helper_preferences",
      preferences as unknown as Record<string, unknown>,
    );
    this.settings.update((next) => {
      next.helperPreferences = preferences;
    });
    this.helperHistory.record(before, preferences);
    return {
      ok: true,
      preferences,
      ...(this.helperHistory.lastWarning
        ? { auditWarning: this.helperHistory.lastWarning }
        : {}),
    };
  }

  @Get("helper/preferences/history")
  helperPreferencesHistory() {
    return this.helperHistory.list();
  }

  @Post("helper/preferences/history/:id/rollback")
  @HttpCode(200)
  rollbackHelperPreferences(@Param("id") id: string) {
    if (!/^[0-9a-f-]{36}$/i.test(id))
      throw new ValidationError(["Ongeldige wijziging."]);
    return this.helperHistory.rollback(id);
  }

  @Get("helper/hotkeys")
  @PublicRoute()
  async helperHotkeys() {
    return this.wallpaper?.helperPreferences
      ? this.wallpaper.helperPreferences()
      : { ok: false, error: "Geen Windows-agent." };
  }
  @Get("windows/status")
  agentStatus(): Promise<WindowsAgentStatus> | WindowsAgentStatus {
    return this.wallpaper?.agentStatus
      ? this.wallpaper.agentStatus()
      : {
          available: false,
          version: null,
          helperOpen: null,
          paused: null,
          mode: null,
          display: null,
          error: "Er is geen Windows-agent ingesteld.",
        };
  }

  @Get("windows/helper-debug")
  helperDebug() {
    return this.wallpaper?.helperDebug
      ? this.wallpaper.helperDebug()
      : {
          available: false,
          helper: null,
          view: null,
          display: null,
          checkedAt: null,
          error: "Er is geen Windows-agent ingesteld.",
        };
  }
  @Put("helper/hotkeys")
  async saveHelperHotkeys(@Body() body: Body_) {
    const input = body?.hotkeys;
    if (!input || typeof input !== "object" || Array.isArray(input))
      throw new ValidationError(["Sneltoetsen ontbreken."]);
    const hotkeys: Record<string, string> = {};
    for (const key of ["open", "speak", "mute", "desktop"]) {
      const value = (input as Record<string, unknown>)[key];
      if (typeof value !== "string" || value.length > 80)
        throw new ValidationError(["Ongeldige sneltoets."]);
      hotkeys[key] = value;
    }
    this.log("helper_hotkeys", { fields: Object.keys(hotkeys) });
    if (!this.wallpaper?.helperPreferences)
      return { ok: false, error: "Geen Windows-agent." };
    let previous:
      | Awaited<ReturnType<NonNullable<WallpaperPort["helperPreferences"]>>>
      | undefined;
    try {
      previous = await this.wallpaper.helperPreferences();
    } catch {
      /* Preserve saves when the read-only history snapshot is unavailable. */
    }
    const result = await this.wallpaper.helperPreferences(hotkeys);
    const history = result.ok
      ? this.helperHotkeyHistory.record(
          previous?.preferences?.hotkeys,
          result.preferences?.hotkeys,
        )
      : undefined;
    return { ...result, ...history };
  }
  @Get("helper/hotkeys/history")
  helperHotkeyHistoryList() {
    return this.helperHotkeyHistory.list();
  }
  @Post("helper/hotkeys/history/:id/rollback")
  rollbackHelperHotkeys(@Param("id") id: string) {
    return this.helperHotkeyHistory.rollback(id, this.wallpaper);
  }

  /** Grants can only be created by a fresh confirmation; this endpoint only revokes. */
  @Delete("standing-approvals/:id")
  revokeStandingApproval(@Param("id") id: string): { ok: true } {
    this.log("standing_approval_revoked", { id });
    this.settings.update((next) => {
      next.standingApprovals = next.standingApprovals.filter(
        (grant) => grant.id !== id,
      );
    });
    return { ok: true };
  }

  /* ---------- backup ---------- */

  @Get("export")
  async exportSettings(): Promise<SettingsBackup> {
    const settings = this.settings.get();
    const backup: SettingsBackup = {
      format: "nova-settings",
      version: 1,
      exportedAt: new Date().toISOString(),
      persona: settings.persona,
      personaStyle: settings.personaStyle,
      personaProfile: settings.personaProfile,
      householdProfiles: settings.householdProfiles,
      activeHouseholdProfileId: settings.activeHouseholdProfileId,
      quickActions: settings.quickActions,
      toolOverrides: settings.toolOverrides,
      // Secret header values are never exported; their names are, so they can be filled in again.
      skills: skillsOf(settings).map(publicSkill),
      widgets: widgetsOf(settings),
      sidebar: (settings.sidebar?.items ?? null) as SettingsBackup["sidebar"],
      helper: { mode: settings.helper.mode, display: settings.helper.display },
      helperPreferences: normalizeHelperPreferences({
        ...settings.helperPreferences,
      }),
      modelRoles: settings.modelRoles,
      lists: this.backups.exportLists(),
      connections: this.backups.exportConnections(),
    };
    if (this.config.nodeRedAdminToken.length >= 32) {
      const snapshot = await this.nodeRedManagement.flowSnapshot();
      backup.nodeRedFlows = snapshot.flows;
      backup.nodeRedFlowsIncluded = true;
    } else {
      backup.nodeRedFlowsIncluded = false;
    }
    if (Buffer.byteLength(JSON.stringify(backup), "utf8") > MAX_BACKUP_BYTES)
      throw new ValidationError([
        "De instellingen zijn te groot voor een back-up van 1 MB.",
      ]);
    return backup;
  }

  @Post("import/prepare")
  @HttpCode(200)
  async prepareImport(@Body() body: unknown) {
    if (
      body &&
      typeof body === "object" &&
      !Array.isArray(body) &&
      "data" in body &&
      body.data &&
      typeof body.data === "object" &&
      !Array.isArray(body.data) &&
      "nodeRedFlows" in body.data
    ) {
      const snapshot = await this.nodeRedManagement.flowSnapshot();
      return this.backups.prepareWithNodeRed(body, snapshot);
    }
    return this.backups.prepare(body);
  }

  @Post("import")
  @HttpCode(200)
  async importSettings(@Body() body: unknown) {
    return this.backups.confirmWithNodeRed(body);
  }
}

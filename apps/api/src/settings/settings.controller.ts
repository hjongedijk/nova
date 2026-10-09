import {
  Body,
  Controller,
  Delete,
  Get,
  HttpCode,
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
  HelperPreferences,
  SettingsBackup,
  SettingsOverview,
  Skill,
  SkillDraftResult,
  SkillRun,
  SkillSuggestion,
  SkillTestResult,
  ToolOverride,
  Widget,
  HelperState,
  WallpaperState,
} from "@nova/contracts";
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
  normalizePersona,
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

const MAX_SKILLS = 50;
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

  @Get()
  overview(): SettingsOverview {
    const settings = this.settings.get();
    const tools = this.tools.list();
    return {
      persona: settings.persona,
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
  setPersona(@Body() body: Body_): { ok: true; persona: string } {
    const persona = normalizePersona(body?.text);
    this.settings.update((settings) => void (settings.persona = persona));
    this.log("persona", { length: persona.length });
    return { ok: true, persona };
  }

  @Put("quick-actions")
  setQuickActions(@Body() body: Body_) {
    const items =
      body?.reset === true ? null : normalizeQuickActions(body?.items);
    this.settings.update((settings) => void (settings.quickActions = items));
    this.log("quick-actions", { count: items?.length ?? "default" });
    return { ok: true, quickActions: items ?? this.settings.quickActions() };
  }

  @Put("tools/:name")
  setTool(
    @Param("name") name: string,
    @Body() body: Body_,
  ): { ok: true; override: ToolOverride } {
    const override = normalizeToolOverride(name, body);
    this.settings.update((settings) => {
      if (Object.keys(override).length) settings.toolOverrides[name] = override;
      else delete settings.toolOverrides[name];
    });
    this.log("tool", { tool: name, ...override });
    return { ok: true, override };
  }

  @Delete("tools/:name")
  resetTool(@Param("name") name: string): { ok: true } {
    normalizeToolOverride(name, {});
    this.settings.update(
      (settings) => void delete settings.toolOverrides[name],
    );
    this.log("tool-reset", { tool: name });
    return { ok: true };
  }

  /** Switch a whole ability on or off: every tool in it. */
  @Put("abilities/:id")
  setAbility(@Param("id") id: string, @Body() body: Body_): { ok: true } {
    if (typeof body?.enabled !== "boolean")
      throw new ValidationError(["Kies aan of uit."]);
    const enabled = body.enabled;
    const group = groupTools(this.tools.list()).find((item) => item.id === id);
    if (!group) throw new NotFoundException("Dat onderdeel bestaat niet.");
    this.settings.update((settings) => {
      for (const name of group.tools) {
        const current = { ...settings.toolOverrides[name] };
        if (enabled) delete current.enabled;
        else current.enabled = false;
        if (Object.keys(current).length) settings.toolOverrides[name] = current;
        else delete settings.toolOverrides[name];
      }
    });
    this.log("ability", {
      ability: group.id,
      enabled,
      tools: group.tools.length,
    });
    return { ok: true };
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
    const { skills } = this.settings.get();
    if (skills.length >= MAX_SKILLS)
      throw new ValidationError([`Maximaal ${MAX_SKILLS} vaardigheden.`]);
    const skill = normalizeSkill(body, {
      takenIds: skillsOf({ skills }).map((item) => item.id),
    });
    this.settings.update(
      (settings) => void settings.skills.push(skill as never),
    );
    this.log("skill-created", { skill: skill.id, type: skill.type });
    return { ok: true, skill: publicSkill(skill) };
  }

  @Put("skills/:id")
  update(
    @Param("id") id: string,
    @Body() body: unknown,
  ): { ok: true; skill: Skill } {
    const existing = skillsOf(this.settings.get()).find(
      (item) => item.id === id,
    );
    if (!existing) throw new NotFoundException("Die vaardigheid bestaat niet.");
    const skill = normalizeSkill(body, { existing });
    this.settings.update((settings) => {
      settings.skills = settings.skills.map((item) =>
        (item as StoredSkill).id === skill.id ? (skill as never) : item,
      );
    });
    this.log("skill-updated", { skill: skill.id, version: skill.version });
    return { ok: true, skill: publicSkill(skill) };
  }

  @Delete("skills/:id")
  remove(@Param("id") id: string): { ok: true } {
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
    this.log("skill-deleted", { skill: existing.id });
    return { ok: true };
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
          error: result?.error ?? null,
          arguments: (entry.arguments ?? {}) as Record<string, unknown>,
        };
      });
    return { runs };
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
  createWidget(@Body() body: unknown): { widget: Widget } {
    let widget!: Widget;
    this.settings.update((settings) => {
      if (settings.widgets.length >= MAX_WIDGETS)
        throw new ValidationError([`Maximaal ${MAX_WIDGETS} panelen.`]);
      widget = normalizeWidget(body, {
        takenIds: widgetsOf(settings).map((item) => item.id),
        skillIds: this.webhookIds(settings),
      });
      settings.widgets.push(widget as never);
    });
    this.log("widget_created", { id: widget.id, type: widget.type });
    return { widget };
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
  ): { widget: Widget } {
    let widget!: Widget;
    this.settings.update((settings) => {
      const index = widgetsOf(settings).findIndex((item) => item.id === id);
      if (index < 0) throw new ValidationError(["Dit paneel bestaat niet."]);
      widget = normalizeWidget(body, {
        existing: widgetsOf(settings)[index],
        skillIds: this.webhookIds(settings),
      });
      settings.widgets[index] = widget as never;
    });
    this.log("widget_updated", { id: widget.id });
    return { widget };
  }

  @Delete("widgets/:id")
  deleteWidget(@Param("id") id: string): { ok: true } {
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
    this.log("widget_deleted", { id });
    return { ok: true };
  }

  @Put("sidebar")
  setSidebar(@Body() body: Body_) {
    this.settings.update((settings) => {
      settings.sidebar =
        body?.reset === true
          ? null
          : {
              items: normalizeSidebar(body?.items, settings) as never[],
            };
    });
    this.log("sidebar_changed", { reset: body?.reset === true });
    return { sidebar: resolveSidebar(this.settings.get()) };
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
    const outcome = await this.wallpaper.setWallpaper(display, mode);
    if (!outcome.ok) throw new ValidationError([outcome.error]);
    this.log("wallpaper", { display, mode });
    return { available: true, displays: outcome.displays };
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
    this.settings.update((next) => {
      next.helper = { mode, display };
    });
    this.log("helper", { mode, display });
    if (!this.wallpaper?.configured)
      return {
        settings: { mode, display },
        desktop: { available: false, reason: "no-agent" },
        applied: false,
        error: "Er is geen Windows-agent ingesteld.",
      };
    const outcome = await this.wallpaper.setMode(mode, display);
    if (!outcome.ok)
      return {
        settings: { mode, display },
        desktop: await this.getWallpaper(),
        applied: false,
        error: outcome.error,
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
    };
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
    return this.settings.get().helperPreferences;
  }

  @Put("helper/preferences")
  saveHelperPreferences(@Body() body: Body_): {
    ok: true;
    preferences: HelperPreferences;
  } {
    const shape = body?.shape;
    const cues = body?.cues as Record<string, unknown> | undefined;
    const quiet = cues?.quiet as Record<string, unknown> | undefined;
    if (
      typeof body?.autohide !== "boolean" ||
      typeof body.contrast !== "boolean" ||
      !["orb", "ring", "mist"].includes(String(shape)) ||
      !cues ||
      typeof cues.enabled !== "boolean" ||
      typeof cues.volume !== "number" ||
      !Number.isFinite(cues.volume) ||
      cues.volume < 0 ||
      cues.volume > 1 ||
      !["soft", "playful", "minimal"].includes(String(cues.theme)) ||
      !quiet ||
      typeof quiet.enabled !== "boolean" ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(quiet.start)) ||
      !/^([01]\d|2[0-3]):[0-5]\d$/.test(String(quiet.end))
    )
      throw new ValidationError(["Ongeldige helperinstellingen."]);
    const names = [
      "listening-start",
      "listening-end",
      "thinking",
      "done",
      "notice",
      "error",
      "approved",
      "declined",
      "greet",
      "goodnight",
      "file",
      "touch",
      "dizzy",
      "heart",
      "wake",
    ];
    const perCue: Record<string, boolean> = {};
    if (cues.cues !== undefined) {
      if (
        !cues.cues ||
        typeof cues.cues !== "object" ||
        Array.isArray(cues.cues)
      )
        throw new ValidationError(["Ongeldige geluiden."]);
      for (const [key, value] of Object.entries(cues.cues)) {
        if (!names.includes(key) || typeof value !== "boolean")
          throw new ValidationError(["Onbekend geluid."]);
        perCue[key] = value;
      }
    }
    const wardrobe = body.wardrobe as Record<string, unknown> | undefined;
    if (
      wardrobe &&
      (!["nova", "violet", "gold"].includes(String(wardrobe.theme)) ||
        typeof wardrobe.seasonal !== "boolean" ||
        typeof wardrobe.birthday !== "string" ||
        (wardrobe.birthday !== "" &&
          !/^(0[1-9]|1[0-2])-(0[1-9]|[12]\d|3[01])$/.test(wardrobe.birthday)))
    )
      throw new ValidationError(["Ongeldige orbkleuren of verjaardag."]);
    const preferences: HelperPreferences = {
      ...(wardrobe
        ? {
            wardrobe: wardrobe as unknown as NonNullable<
              HelperPreferences["wardrobe"]
            >,
          }
        : {}),
      autohide: body.autohide,
      contrast: body.contrast,
      shape: shape as HelperPreferences["shape"],
      cues: {
        enabled: cues.enabled,
        volume: cues.volume,
        theme: cues.theme as HelperPreferences["cues"]["theme"],
        cues: perCue,
        quiet: {
          enabled: quiet.enabled,
          start: String(quiet.start),
          end: String(quiet.end),
        },
      },
    };
    this.log(
      "helper_preferences",
      preferences as unknown as Record<string, unknown>,
    );
    this.settings.update((next) => {
      next.helperPreferences = preferences;
    });
    return { ok: true, preferences };
  }

  @Get("helper/hotkeys")
  @PublicRoute()
  async helperHotkeys() {
    return this.wallpaper?.helperPreferences
      ? this.wallpaper.helperPreferences()
      : { ok: false, error: "Geen Windows-agent." };
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
    this.log("helper_hotkeys", { hotkeys });
    return this.wallpaper?.helperPreferences
      ? this.wallpaper.helperPreferences(hotkeys)
      : { ok: false, error: "Geen Windows-agent." };
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
  exportSettings(): SettingsBackup {
    const settings = this.settings.get();
    return {
      format: "nova-settings",
      version: 1,
      exportedAt: new Date().toISOString(),
      persona: settings.persona,
      quickActions: settings.quickActions,
      toolOverrides: settings.toolOverrides,
      // Secret header values are never exported; their names are, so they can be filled in again.
      skills: skillsOf(settings).map(publicSkill),
      widgets: widgetsOf(settings),
      sidebar: (settings.sidebar?.items ?? null) as SettingsBackup["sidebar"],
    };
  }

  @Post("import")
  @HttpCode(200)
  importSettings(@Body() body: Body_) {
    const data = body?.data as Record<string, unknown> | undefined;
    if (data?.format !== "nova-settings")
      throw new ValidationError(["Dit is geen NOVA-back-up."]);
    const replace = body?.mode === "replace";
    const incoming = Array.isArray(data.skills)
      ? (data.skills as unknown[])
      : [];
    if (incoming.length > MAX_SKILLS)
      throw new ValidationError([`Maximaal ${MAX_SKILLS} vaardigheden.`]);
    const missingSecrets: { skill: string; headers: string[] }[] = [];
    const skills = incoming.map((value) => {
      const raw = value as {
        name?: string;
        http?: { secretHeaders?: { name?: string }[] };
      } | null;
      const secretNames = (raw?.http?.secretHeaders ?? [])
        .map((row) => row?.name)
        .filter((name): name is string => Boolean(name));
      if (secretNames.length)
        missingSecrets.push({ skill: String(raw?.name), headers: secretNames });
      const withoutSecrets = raw?.http
        ? { ...raw, http: { ...raw.http, secretHeaders: [] } }
        : raw;
      return normalizeSkill(withoutSecrets, { takenIds: [] });
    });
    const persona =
      data.persona !== undefined ? normalizePersona(data.persona) : undefined;
    const actions =
      data.quickActions == null
        ? undefined
        : normalizeQuickActions(data.quickActions);
    const incomingWidgets = Array.isArray(data.widgets)
      ? (data.widgets as Record<string, unknown>[])
      : [];
    if (incomingWidgets.length > MAX_WIDGETS)
      throw new ValidationError([`Maximaal ${MAX_WIDGETS} panelen.`]);
    const overrides: Record<string, ToolOverride> = {};
    for (const [name, override] of Object.entries(
      (data.toolOverrides ?? {}) as Record<string, Record<string, unknown>>,
    )) {
      const clean = normalizeToolOverride(name, override);
      if (Object.keys(clean).length) overrides[name] = clean;
    }
    this.settings.update((settings) => {
      const byId = new Map(
        (replace ? [] : skillsOf(settings)).map((item) => [item.id, item]),
      );
      for (const skill of skills) byId.set(skill.id, skill);
      settings.skills = [...byId.values()].slice(0, MAX_SKILLS) as never[];
      if (persona !== undefined) settings.persona = persona;
      if (actions !== undefined) settings.quickActions = actions;
      settings.toolOverrides = replace
        ? overrides
        : { ...settings.toolOverrides, ...overrides };
      const skillIds = skillsOf(settings).map((item) => item.id);
      const widgetsById = new Map(
        (replace ? [] : widgetsOf(settings)).map((item) => [item.id, item]),
      );
      for (const raw of incomingWidgets) {
        const widget = normalizeWidget(raw, { takenIds: [], skillIds });
        widgetsById.set(widget.id, widget);
      }
      settings.widgets = [...widgetsById.values()].slice(
        0,
        MAX_WIDGETS,
      ) as never[];
      if (Array.isArray(data.sidebar))
        settings.sidebar = {
          items: normalizeSidebar(
            (data.sidebar as { id?: string }[]).filter(
              (item) =>
                BUILTIN_PANELS.some((panel) => panel.id === item?.id) ||
                widgetsOf(settings).some((w) => `w:${w.id}` === item?.id),
            ),
            settings,
          ) as never[],
        };
    });
    this.log("imported", { skills: skills.length, replace });
    return { ok: true, imported: skills.length, missingSecrets };
  }
}

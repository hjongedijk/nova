import type { SettingsBackupListItem, Widget } from "@nova/contracts";
import { ValidationError } from "../core/errors/validation.error.js";
import { sanitize } from "../core/security/sanitize.js";
import {
  normalizeHelperPreferences as rawNormalizeHelperPreferences,
  normalizePersona as rawnormalizePersona,
  normalizePersonaStyle as rawNormalizePersonaStyle,
  normalizePersonaProfile as rawNormalizePersonaProfile,
  normalizeHouseholdProfiles as rawNormalizeHouseholdProfiles,
  normalizeQuickActions as rawnormalizeQuickActions,
  normalizeSidebar as rawnormalizeSidebar,
  normalizeToolOverride as rawnormalizeToolOverride,
} from "./settings-validation.js";
import {
  normalizeSkill as rawNormalizeSkill,
  publicSkill,
  type StoredSkill,
} from "./skills/skills.js";
import type { NovaSettings } from "./store/settings.store.js";
import { normalizeWidget as rawNormalizeWidget } from "./widgets/widgets.js";
import { normalizeNodeRedBackupFlows } from "./node-red-management.service.js";

function checked<A extends unknown[], R>(
  normalizer: (...args: A) => R,
): (...args: A) => R {
  return (...args) => {
    try {
      return normalizer(...args);
    } catch (error) {
      if (error instanceof ValidationError)
        throw new ValidationError([
          "De back-up bevat ongeldige vaardigheden, panelen of instellingen. Controleer de velden.",
        ]);
      throw error;
    }
  };
}
const normalizePersona = checked(rawnormalizePersona);
const normalizePersonaStyle = checked(rawNormalizePersonaStyle);
const normalizePersonaProfile = checked(rawNormalizePersonaProfile);
const normalizeHouseholdProfiles = checked(rawNormalizeHouseholdProfiles);
const normalizeQuickActions = checked(rawnormalizeQuickActions);
const normalizeSidebar = checked(rawnormalizeSidebar);
const normalizeToolOverride = checked(rawnormalizeToolOverride);
const normalizeSkill = checked(rawNormalizeSkill);
const normalizeWidget = checked(rawNormalizeWidget);
const normalizeHelperPreferences = checked(rawNormalizeHelperPreferences);

export const MAX_BACKUP_BYTES = 1_000_000;
const MAX_SKILLS = 50;
const MAX_WIDGETS = 20;
const MAX_LISTS = 100;
const MAX_LIST_ITEMS = 100;
const ID = /^[a-z0-9_]{1,40}$/;
const HEADER = /^[A-Za-z][A-Za-z0-9-]{0,39}$/;
const FORBIDDEN_HEADER =
  /^(?:host|content-length|connection|transfer-encoding|x-nova-admin|x-nova-pin)$/i;
const fields = [
  "format",
  "version",
  "exportedAt",
  "persona",
  "personaStyle",
  "personaProfile",
  "householdProfiles",
  "activeHouseholdProfileId",
  "quickActions",
  "toolOverrides",
  "skills",
  "widgets",
  "sidebar",
  "helper",
  "helperPreferences",
  "modelRoles",
  "nodeRedFlows",
  "nodeRedFlowsIncluded",
  "lists",
  "connections",
];

export interface BackupPlanSummary {
  mode: "merge" | "replace";
  incomingSkills: number;
  totalSkills: number;
  incomingWidgets: number;
  totalWidgets: number;
  incomingLists: number;
  totalLists: number;
  removedLists: number;
  incomingFlows: number;
  totalFlows: number;
  removedFlows: number;
  replacedSkills: number;
  removedSkills: number;
  removedWidgets: number;
  personaChanged: boolean;
  personaStyleChanged: boolean;
  personaProfileChanged: boolean;
  householdProfilesChanged: boolean;
  quickActionsChanged: boolean;
  toolOverridesChanged: boolean;
  sidebarChanged: boolean;
  helperChanged: boolean;
  helperPreferencesChanged: boolean;
  modelRolesChanged: boolean;
  listsChanged: boolean;
  nodeRedFlowsChanged: boolean;
  connectionsChanged: boolean;
  changedConnections: number;
  connectionChanges: {
    service: string;
    before: Record<string, string | boolean>;
    after: Record<string, string | boolean>;
  }[];
  missingSecrets: { skill: string; headers: string[] }[];
}

function fail(message: string): never {
  throw new ValidationError([message]);
}
export function normalizeBackupLists(
  value: unknown,
): Record<string, SettingsBackupListItem[]> {
  const raw = object(value);
  if (Object.keys(raw).length > MAX_LISTS) fail("Maximaal 100 lijsten.");
  const normalized: Record<string, SettingsBackupListItem[]> = {};
  for (const [name, rawItems] of Object.entries(raw)) {
    if (
      !name ||
      name.length > 40 ||
      name !== name.trim().toLowerCase() ||
      sanitize(name) !== name ||
      !Array.isArray(rawItems) ||
      rawItems.length > MAX_LIST_ITEMS
    )
      fail("De back-up bevat een ongeldige lijst.");
    const seenIds = new Set<string>();
    const seenTexts = new Set<string>();
    normalized[name] = rawItems.map((rawItem) => {
      const item = object(rawItem);
      if (
        Object.keys(item).some(
          (key) => !["id", "text", "addedAt"].includes(key),
        ) ||
        typeof item.id !== "string" ||
        !/^[a-f0-9]{8}$/i.test(item.id) ||
        typeof item.text !== "string" ||
        !item.text.trim() ||
        item.text !== item.text.trim() ||
        item.text.length > 200 ||
        sanitize(item.text) !== item.text ||
        typeof item.addedAt !== "string" ||
        !Number.isFinite(Date.parse(item.addedAt))
      )
        fail("De back-up bevat een ongeldig lijstitem.");
      const textKey = item.text.toLowerCase();
      if (seenIds.has(item.id) || seenTexts.has(textKey))
        fail("Een lijstitem staat dubbel in de back-up.");
      seenIds.add(item.id);
      seenTexts.add(textKey);
      return {
        id: item.id.toLowerCase(),
        text: item.text,
        addedAt: new Date(item.addedAt).toISOString(),
      };
    });
  }
  return normalized;
}
function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value))
    fail("Ongeldige gegevens in de NOVA-back-up.");
  return value as Record<string, unknown>;
}
function list(data: Record<string, unknown>, field: string): unknown[] {
  if (!Object.hasOwn(data, field)) return [];
  if (!Array.isArray(data[field]))
    fail("Vaardigheden en panelen moeten lijsten zijn.");
  return data[field];
}
function stableId(raw: Record<string, unknown>, generated: string): string {
  if (!Object.hasOwn(raw, "id")) return generated;
  if (typeof raw.id !== "string" || !ID.test(raw.id))
    fail("Een vaardigheid of paneel heeft een ongeldige ID.");
  return raw.id;
}

function exactKeys(
  value: Record<string, unknown>,
  required: string[],
  optional: string[] = [],
): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some(
      (key) => !required.includes(key) && !optional.includes(key),
    )
  )
    fail(
      "De helperinstellingen bevatten ontbrekende of niet-ondersteunde velden.",
    );
}

function helperPreferences(value: unknown): NovaSettings["helperPreferences"] {
  const body = object(value);
  exactKeys(
    body,
    ["autohide", "contrast", "shape", "cues"],
    ["wardrobe", "notifications", "rituals", "avatar"],
  );
  const cues = object(body.cues);
  exactKeys(cues, ["enabled", "volume", "theme", "quiet"], ["cues"]);
  const quiet = object(cues.quiet);
  exactKeys(quiet, ["enabled", "start", "end"]);
  if (
    typeof body.shape !== "string" ||
    typeof cues.theme !== "string" ||
    typeof quiet.start !== "string" ||
    typeof quiet.end !== "string"
  )
    fail("De helperinstellingen bevatten ongeldige waarden.");
  const perCue = Object.hasOwn(cues, "cues") ? object(cues.cues) : undefined;
  const notifications = Object.hasOwn(body, "notifications")
    ? object(body.notifications)
    : undefined;
  const rituals = Object.hasOwn(body, "rituals")
    ? object(body.rituals)
    : undefined;
  if (rituals) {
    exactKeys(
      rituals,
      ["morning", "evening", "checkIn"],
      [
        "weeklyOverview",
        "dailyHighlight",
        "smallSurprises",
        "welcomeHome",
        "calendarReminders",
      ],
    );
    exactKeys(object(rituals.morning), ["enabled", "time"]);
    exactKeys(object(rituals.evening), ["enabled", "time"]);
    exactKeys(object(rituals.checkIn), ["enabled", "afterHours"]);
    if (Object.hasOwn(rituals, "weeklyOverview"))
      exactKeys(object(rituals.weeklyOverview), ["enabled", "time"]);
    if (Object.hasOwn(rituals, "dailyHighlight"))
      exactKeys(object(rituals.dailyHighlight), ["enabled", "time"]);
    if (Object.hasOwn(rituals, "smallSurprises"))
      exactKeys(object(rituals.smallSurprises), ["enabled"]);
    if (Object.hasOwn(rituals, "welcomeHome"))
      exactKeys(object(rituals.welcomeHome), ["enabled"]);
    if (Object.hasOwn(rituals, "calendarReminders"))
      exactKeys(object(rituals.calendarReminders), [
        "enabled",
        "minutesBefore",
      ]);
  }
  if (notifications)
    exactKeys(
      notifications,
      ["info", "warning", "critical", "timer"],
      ["briefing"],
    );
  let wardrobe: Record<string, unknown> | undefined;
  if (Object.hasOwn(body, "wardrobe")) {
    const raw = object(body.wardrobe);
    exactKeys(raw, ["theme", "seasonal", "birthday"]);
    if (typeof raw.theme !== "string") fail("De orbkleuren zijn ongeldig.");
    wardrobe = {
      theme: raw.theme,
      seasonal: raw.seasonal,
      birthday: raw.birthday,
    };
  }
  return normalizeHelperPreferences({
    autohide: body.autohide,
    contrast: body.contrast,
    shape: body.shape,
    ...(body.avatar !== undefined ? { avatar: body.avatar } : {}),
    ...(notifications ? { notifications } : {}),
    ...(rituals ? { rituals } : {}),
    cues: {
      enabled: cues.enabled,
      volume: cues.volume,
      theme: cues.theme,
      quiet: { enabled: quiet.enabled, start: quiet.start, end: quiet.end },
      ...(perCue ? { cues: perCue } : {}),
    },
    ...(wardrobe ? { wardrobe } : {}),
  });
}

function modelRoles(value: unknown): NovaSettings["modelRoles"] {
  const body = object(value);
  const roles = [
    "conversation",
    "code",
    "planning",
    "summary",
    "vision",
    "embedding",
  ] as const;
  exactKeys(body, [...roles]);
  const result = {} as NovaSettings["modelRoles"];
  for (const role of roles) {
    const row = object(body[role]);
    exactKeys(row, ["preferred", "fallback"]);
    if (
      !Array.isArray(row.preferred) ||
      row.preferred.length > 5 ||
      row.preferred.some(
        (item) =>
          typeof item !== "string" ||
          !/^[A-Za-z0-9_.:/-]{1,200}$/.test(item) ||
          sanitize(item) !== item,
      ) ||
      new Set(row.preferred).size !== row.preferred.length ||
      (row.fallback !== null &&
        (typeof row.fallback !== "string" ||
          !/^[A-Za-z0-9_.:/-]{1,200}$/.test(row.fallback) ||
          sanitize(row.fallback) !== row.fallback ||
          row.preferred.includes(row.fallback)))
    )
      fail("De modelrollen bevatten ongeldige voorkeuren.");
    result[role] = {
      preferred: [...row.preferred] as string[],
      fallback: row.fallback as string | null,
    };
  }
  return result;
}

/** A private detached candidate. Callers must expose only the summary before confirmation. */
export function buildBackupPlan(
  data: unknown,
  mode: unknown,
  current: NovaSettings,
  currentLists: Record<string, SettingsBackupListItem[]> = {},
  currentNodeRedFlows: Record<string, unknown>[] = [],
): {
  next: NovaSettings;
  nextLists: Record<string, SettingsBackupListItem[]>;
  nextNodeRedFlows: Record<string, unknown>[];
  summary: BackupPlanSummary;
} {
  const raw = object(data);
  if (mode !== "merge" && mode !== "replace")
    fail("Kies samenvoegen of vervangen voor de back-up.");
  if (raw.format !== "nova-settings" || raw.version !== 1)
    fail("Gebruik een NOVA-back-up van versie 1.");
  if (Object.keys(raw).some((key) => !fields.includes(key)))
    fail("De back-up bevat niet-ondersteunde instellingen.");
  if (
    Object.hasOwn(raw, "exportedAt") &&
    (typeof raw.exportedAt !== "string" || raw.exportedAt.length > 100)
  )
    fail("Het exporttijdstip in de back-up is ongeldig.");
  let input: Record<string, unknown>;
  let next: NovaSettings;
  try {
    const serialized = JSON.stringify(raw);
    if (Buffer.byteLength(serialized, "utf8") > MAX_BACKUP_BYTES)
      fail("De back-up is te groot (maximaal 1 MB).");
    input = structuredClone(raw);
    next = structuredClone(current);
  } catch (error) {
    if (error instanceof ValidationError) throw error;
    fail("De back-up moet geldige JSON-gegevens bevatten.");
  }
  const incoming = list(input, "skills");
  const incomingWidgets = list(input, "widgets");
  const listsProvided = Object.hasOwn(input, "lists");
  const incomingLists = listsProvided ? object(input.lists) : {};
  if (Object.keys(incomingLists).length > MAX_LISTS)
    fail("Maximaal 100 lijsten.");
  if (incoming.length > MAX_SKILLS) fail("Maximaal 50 vaardigheden.");
  if (incomingWidgets.length > MAX_WIDGETS) fail("Maximaal 20 panelen.");
  const oldSkills = new Map(
    next.skills.map((skill) => [String(skill.id), skill]),
  );
  const oldLists = listsProvided
    ? normalizeBackupLists(currentLists)
    : structuredClone(currentLists);
  const importedLists = listsProvided
    ? normalizeBackupLists(incomingLists)
    : {};
  const nextLists = structuredClone(
    listsProvided && mode === "replace" ? {} : oldLists,
  );
  if (listsProvided) {
    for (const [name, items] of Object.entries(importedLists)) {
      if (mode === "replace") {
        nextLists[name] = items;
        continue;
      }
      const merged = [...(nextLists[name] ?? [])];
      for (const item of items) {
        const existingIndex = merged.findIndex(
          (row) =>
            row.id === item.id ||
            row.text.toLowerCase() === item.text.toLowerCase(),
        );
        if (existingIndex < 0) merged.push(item);
        else merged[existingIndex] = item;
      }
      if (merged.length > MAX_LIST_ITEMS)
        fail("Samenvoegen levert een lijst met meer dan 100 items op.");
      nextLists[name] = merged;
    }
  }
  if (Object.keys(nextLists).length > MAX_LISTS)
    fail("Samenvoegen levert meer dan 100 lijsten op.");
  const hasNodeRedFlows = Object.hasOwn(input, "nodeRedFlows");
  if (
    Object.hasOwn(input, "nodeRedFlowsIncluded") &&
    typeof input.nodeRedFlowsIncluded !== "boolean"
  )
    fail("De Node-RED-backupstatus is ongeldig.");
  if (
    (input.nodeRedFlowsIncluded === true && !hasNodeRedFlows) ||
    (input.nodeRedFlowsIncluded === false && hasNodeRedFlows)
  )
    fail("De Node-RED-backupstatus komt niet overeen met de flowgegevens.");
  let incomingFlows: Record<string, unknown>[] = [];
  if (hasNodeRedFlows) {
    try {
      incomingFlows = normalizeNodeRedBackupFlows(input.nodeRedFlows);
    } catch {
      fail(
        "De back-up bevat ongeldige flows of mogelijk geheime Node-RED-velden.",
      );
    }
  }
  const nextNodeRedFlows = structuredClone(
    mode === "replace" && hasNodeRedFlows ? incomingFlows : currentNodeRedFlows,
  );
  if (mode === "merge" && hasNodeRedFlows) {
    const indexes = new Map(
      nextNodeRedFlows.map((node, index) => [String(node.id), index]),
    );
    for (const node of incomingFlows) {
      const index = indexes.get(String(node.id));
      if (index === undefined) {
        indexes.set(String(node.id), nextNodeRedFlows.length);
        nextNodeRedFlows.push(node);
      } else nextNodeRedFlows[index] = node;
    }
  }
  const flowTabs = (flows: Record<string, unknown>[]) =>
    flows.filter((node) => node.type === "tab");
  const incomingFlowIds = new Set(
    flowTabs(incomingFlows).map((node) => String(node.id)),
  );
  const removedFlows =
    mode === "replace" && hasNodeRedFlows
      ? flowTabs(currentNodeRedFlows).filter(
          (node) => !incomingFlowIds.has(String(node.id)),
        ).length
      : 0;
  const skills = new Map(mode === "merge" ? oldSkills : []);
  const seenSkills = new Set<string>();
  const missingSecrets: BackupPlanSummary["missingSecrets"] = [];
  const secretValues: string[] = [];
  for (const skill of current.skills) {
    if (skill.type !== "webhook") continue;
    const http = object(skill.http);
    if (Array.isArray(http.secretHeaders))
      for (const entry of http.secretHeaders) {
        const header = object(entry);
        if (typeof header.value === "string" && header.value)
          secretValues.push(header.value);
      }
  }
  for (const value of incoming) {
    const draft = object(value);
    let names: string[] = [];
    let http: Record<string, unknown> | undefined;
    if (Object.hasOwn(draft, "http")) {
      http = object(draft.http);
      if (Object.hasOwn(http, "secretHeaders")) {
        if (!Array.isArray(http.secretHeaders))
          fail("Geheime headers moeten een lijst zijn.");
        names = http.secretHeaders.map((value) => {
          const header = object(value);
          if (typeof header.name !== "string")
            fail("Een geheime header heeft een ongeldige naam.");
          const name = header.name.trim();
          if (
            !HEADER.test(name) ||
            FORBIDDEN_HEADER.test(name) ||
            sanitize(name) !== name
          )
            fail("Een geheime header heeft een ongeldige naam.");
          if (
            Object.keys(header).some(
              (key) => !["name", "set", "value"].includes(key),
            ) ||
            (Object.hasOwn(header, "set") && header.set !== true) ||
            (Object.hasOwn(header, "value") && typeof header.value !== "string")
          )
            fail("Een geheime header heeft ongeldige gegevens.");
          if (typeof header.value === "string" && header.value)
            secretValues.push(header.value);
          return name;
        });
        if (
          new Set(names.map((name) => name.toLowerCase())).size !== names.length
        )
          fail("Een geheime header staat er twee keer in.");
      }
    }
    if (names.length && draft.type !== "webhook")
      fail("Geheime headers horen alleen bij een webhook.");
    const clean = normalizeSkill(
      http ? { ...draft, http: { ...http, secretHeaders: [] } } : draft,
    );
    clean.id = stableId(draft, clean.id);
    if (seenSkills.has(clean.id))
      fail("Een vaardigheid staat twee keer in de back-up.");
    seenSkills.add(clean.id);
    const old =
      mode === "merge"
        ? (oldSkills.get(clean.id) as unknown as StoredSkill | undefined)
        : undefined;
    const oldHeaders = old?.type === "webhook" ? old.http.secretHeaders : [];
    const oldNames = oldHeaders.map(({ name }) => name.toLowerCase());
    const declarations = names.map((name) => name.toLowerCase());
    const compatible =
      clean.type === "webhook" &&
      old?.type === "webhook" &&
      clean.http.url === old.http.url &&
      clean.http.method === old.http.method &&
      oldNames.length === declarations.length &&
      oldNames.every((name) => declarations.includes(name));
    if (compatible && clean.type === "webhook") {
      clean.http.secretHeaders = names.map((name) => ({
        name,
        value: oldHeaders.find(
          (header) => header.name.toLowerCase() === name.toLowerCase(),
        )!.value,
      }));
    } else {
      const missing = new Map<string, string>();
      for (const name of [...names, ...oldHeaders.map(({ name }) => name)])
        missing.set(name.toLowerCase(), name);
      if (missing.size)
        missingSecrets.push({
          skill: clean.name,
          headers: [...missing.values()],
        });
    }
    if (
      clean.type === "webhook" &&
      clean.http.headers.length + names.length > 8
    )
      fail("Maximaal 8 headers.");
    if (
      clean.type === "webhook" &&
      clean.http.headers.some(({ name }) =>
        declarations.includes(name.toLowerCase()),
      )
    )
      fail("Een header staat twee keer in de back-up.");
    skills.set(clean.id, clean as unknown as Record<string, unknown>);
  }
  if (skills.size > MAX_SKILLS)
    fail("Samenvoegen levert meer dan 50 vaardigheden op.");
  next.skills = [...skills.values()];
  const skillIds = next.skills
    .filter((skill) => skill.type === "webhook")
    .map((skill) => String(skill.id));
  const oldWidgets = new Map(
    next.widgets.map((widget) => [String(widget.id), widget]),
  );
  const widgets = new Map(mode === "merge" ? oldWidgets : []);
  const seenWidgets = new Set<string>();
  for (const value of incomingWidgets) {
    const draft = object(value);
    const clean = normalizeWidget(draft, { skillIds });
    clean.id = stableId(draft, clean.id);
    if (seenWidgets.has(clean.id))
      fail("Een paneel staat twee keer in de back-up.");
    seenWidgets.add(clean.id);
    widgets.set(clean.id, clean as unknown as Record<string, unknown>);
  }
  if (widgets.size > MAX_WIDGETS)
    fail("Samenvoegen levert meer dan 20 panelen op.");
  // Existing button panels also have to remain valid after imported skills replace their targets.
  next.widgets = [...widgets.values()].map(
    (widget) =>
      normalizeWidget(widget, {
        existing: widget as unknown as Widget,
        skillIds,
      }) as unknown as Record<string, unknown>,
  );
  if (Object.hasOwn(input, "persona"))
    next.persona = normalizePersona(input.persona);
  if (Object.hasOwn(input, "personaStyle"))
    next.personaStyle = normalizePersonaStyle(input.personaStyle);
  if (Object.hasOwn(input, "personaProfile")) {
    const profile = object(input.personaProfile);
    exactKeys(profile, ["name", "character", "address", "avoid"]);
    const limits = { name: 40, character: 300, address: 40, avoid: 300 };
    if (
      Object.keys(limits).some(
        (key) =>
          typeof profile[key] !== "string" ||
          (profile[key] as string).trim().length >
            limits[key as keyof typeof limits],
      ) ||
      !(profile.name as string).trim()
    )
      fail("De NOVA-profielvelden in de back-up zijn ongeldig.");
    next.personaProfile = normalizePersonaProfile(profile);
  }
  if (Object.hasOwn(input, "householdProfiles")) {
    const profiles = normalizeHouseholdProfiles(input.householdProfiles);
    const activeId = input.activeHouseholdProfileId;
    if (
      activeId !== undefined &&
      (typeof activeId !== "string" ||
        !profiles.some((profile) => profile.id === activeId))
    )
      fail("Het actieve gezinsprofiel in de back-up is ongeldig.");
    const active =
      profiles.find((profile) => profile.id === activeId) ?? profiles[0]!;
    next.householdProfiles = profiles;
    next.activeHouseholdProfileId = active.id;
    next.personaProfile = active.personaProfile;
  } else if (Object.hasOwn(input, "personaProfile")) {
    // Older v1 exports only contained one persona profile.
    const legacyProfile = normalizePersonaProfile(input.personaProfile);
    if (mode === "replace") {
      next.householdProfiles = [
        {
          id: "primary",
          label: "Gebruiker",
          personaProfile: legacyProfile,
          communicationPreferences: [],
        },
      ];
      next.activeHouseholdProfileId = "primary";
    } else {
      next.householdProfiles = next.householdProfiles.map((profile) =>
        profile.id === next.activeHouseholdProfileId
          ? { ...profile, personaProfile: legacyProfile }
          : profile,
      );
    }
    next.personaProfile = legacyProfile;
  }
  if (Object.hasOwn(input, "quickActions"))
    next.quickActions =
      input.quickActions === null
        ? null
        : normalizeQuickActions(input.quickActions);
  const overrides = Object.hasOwn(input, "toolOverrides")
    ? object(input.toolOverrides)
    : {};
  const cleanOverrides = Object.fromEntries(
    Object.entries(overrides)
      .map(
        ([name, value]) =>
          [name, normalizeToolOverride(name, object(value))] as const,
      )
      .filter(([, value]) => Object.keys(value).length),
  );
  next.toolOverrides =
    mode === "replace"
      ? cleanOverrides
      : { ...next.toolOverrides, ...cleanOverrides };
  if (Object.hasOwn(input, "sidebar")) {
    next.sidebar =
      input.sidebar === null
        ? null
        : {
            items: normalizeSidebar(input.sidebar, next) as unknown as Record<
              string,
              unknown
            >[],
          };
  } else if (next.sidebar) {
    next.sidebar = {
      items: normalizeSidebar(next.sidebar.items, next) as unknown as Record<
        string,
        unknown
      >[],
    };
  }
  if (Object.hasOwn(input, "helper")) {
    const helper = object(input.helper);
    exactKeys(helper, ["mode", "display"]);
    if (
      (helper.mode !== "wallpaper" &&
        helper.mode !== "helper" &&
        helper.mode !== "both") ||
      typeof helper.display !== "number" ||
      !Number.isInteger(helper.display) ||
      helper.display < 0 ||
      helper.display > 8
    )
      fail(
        "Kies achtergrond, helper of beide en een beeldscherm van 0 tot en met 8.",
      );
    next.helper = { mode: helper.mode, display: helper.display };
  }
  if (Object.hasOwn(input, "helperPreferences"))
    next.helperPreferences = helperPreferences(input.helperPreferences);
  if (Object.hasOwn(input, "modelRoles"))
    next.modelRoles = modelRoles(input.modelRoles);
  const privateValues = [...new Set(secretValues)];
  const assertPublicText = (value: string): void => {
    if (
      sanitize(value) !== value ||
      privateValues.some((secret) =>
        secret.length >= 4 ? value.includes(secret) : value === secret,
      )
    )
      fail(
        "De zichtbare instellingen bevatten een geheim. Verwijder dit uit de back-up of bestaande instellingen.",
      );
  };
  const assertPublic = (value: unknown): void => {
    if (typeof value === "string") assertPublicText(value);
    else if (Array.isArray(value)) value.forEach(assertPublic);
    else if (value && typeof value === "object") {
      for (const [key, item] of Object.entries(value)) {
        assertPublicText(key);
        assertPublic(item);
      }
    }
  };
  // Check the complete result after collecting every declared secret, including later imports.
  // Stored webhook credentials remain private and are deliberately absent from this projection.
  assertPublic({
    skills: next.skills.map((skill) =>
      publicSkill(skill as unknown as StoredSkill),
    ),
    widgets: next.widgets,
    persona: next.persona,
    personaStyle: next.personaStyle,
    personaProfile: next.personaProfile,
    householdProfiles: next.householdProfiles,
    activeHouseholdProfileId: next.activeHouseholdProfileId,
    quickActions: next.quickActions,
    toolOverrides: next.toolOverrides,
    sidebar: next.sidebar,
    helper: next.helper,
    helperPreferences: next.helperPreferences,
    modelRoles: next.modelRoles,
    ...(hasNodeRedFlows ? { nodeRedFlows: nextNodeRedFlows } : {}),
    ...(listsProvided ? { lists: nextLists } : {}),
    ...(Object.hasOwn(input, "connections")
      ? { connections: input.connections }
      : {}),
  });
  const safeSummary = (value: string): string => {
    let clean = sanitize(value);
    for (const secret of secretValues)
      clean = clean.split(secret).join("[redacted]");
    return clean;
  };
  return {
    next,
    nextLists,
    nextNodeRedFlows,
    summary: {
      mode,
      incomingSkills: incoming.length,
      totalSkills: skills.size,
      incomingWidgets: incomingWidgets.length,
      totalWidgets: widgets.size,
      incomingLists: Object.keys(importedLists).length,
      totalLists: Object.keys(nextLists).length,
      removedLists:
        listsProvided && mode === "replace"
          ? Object.keys(oldLists).filter(
              (name) => !Object.hasOwn(importedLists, name),
            ).length
          : 0,
      incomingFlows: flowTabs(incomingFlows).length,
      totalFlows: flowTabs(nextNodeRedFlows).length,
      removedFlows,
      replacedSkills: [...seenSkills].filter((id) => oldSkills.has(id)).length,
      removedSkills:
        mode === "replace"
          ? [...oldSkills.keys()].filter((id) => !seenSkills.has(id)).length
          : 0,
      removedWidgets:
        mode === "replace"
          ? [...oldWidgets.keys()].filter((id) => !seenWidgets.has(id)).length
          : 0,
      personaChanged: next.persona !== current.persona,
      personaStyleChanged: next.personaStyle !== current.personaStyle,
      personaProfileChanged:
        JSON.stringify(next.personaProfile) !==
        JSON.stringify(current.personaProfile),
      householdProfilesChanged:
        JSON.stringify(next.householdProfiles) !==
          JSON.stringify(current.householdProfiles) ||
        next.activeHouseholdProfileId !== current.activeHouseholdProfileId,
      quickActionsChanged:
        JSON.stringify(next.quickActions) !==
        JSON.stringify(current.quickActions),
      toolOverridesChanged:
        JSON.stringify(next.toolOverrides) !==
        JSON.stringify(current.toolOverrides),
      sidebarChanged:
        JSON.stringify(next.sidebar) !== JSON.stringify(current.sidebar),
      helperChanged:
        JSON.stringify(next.helper) !== JSON.stringify(current.helper),
      helperPreferencesChanged:
        JSON.stringify(next.helperPreferences) !==
        JSON.stringify(current.helperPreferences),
      modelRolesChanged:
        JSON.stringify(next.modelRoles) !== JSON.stringify(current.modelRoles),
      listsChanged: JSON.stringify(nextLists) !== JSON.stringify(oldLists),
      nodeRedFlowsChanged:
        hasNodeRedFlows &&
        JSON.stringify(nextNodeRedFlows) !==
          JSON.stringify(currentNodeRedFlows),
      connectionsChanged: false,
      changedConnections: 0,
      connectionChanges: [],
      missingSecrets: missingSecrets.map(({ skill, headers }) => ({
        skill: safeSummary(skill),
        headers: headers.map(safeSummary),
      })),
    },
  };
}

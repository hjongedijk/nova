import { Inject, Optional } from "@nestjs/common";
import type { HaEntity } from "@nova/contracts";
import { SessionMemoryService } from "../memory/session-memory.service.js";
import {
  schema,
  text,
  number,
  ToolSourceProvider,
  type ToolCall,
  type ToolDefinition,
  type ToolPlan,
  type ToolPlanError,
  type ToolResult,
  type ToolSource,
} from "../tools/tool.types.js";
import { HOME_ALIAS_LOOKUP, type HomeAliasLookup } from "./alias-lookup.js";
import {
  HomeAssistantService,
  type HaState,
  type Resolved,
} from "./home-assistant.service.js";
import { HomeSummaryService } from "./home-summary.service.js";
import { actionRisk } from "./risk.js";

type Args = Record<string, unknown>;
type Data = Record<string, unknown>;
type Definition = Omit<ToolDefinition, "parameters"> & {
  parameters: ToolDefinition["parameters"];
};

/** What `prepare` worked out for a call that changes something. */
interface Prepared {
  entity?: HaEntity;
  entities?: HaEntity[];
  domain?: string;
  service?: string;
  data?: Data;
}

const string = text();
const target = { entity_id: string };
const idList = (minItems: number, maxItems: number) => ({
  type: "array",
  items: string,
  minItems,
  maxItems,
  uniqueItems: true,
});

const ALLOWED_SERVICES: Record<string, Record<string, string[]>> = {
  light: { turn_on: ["brightness_pct", "rgb_color"], turn_off: [], toggle: [] },
  switch: { turn_on: [], turn_off: [], toggle: [] },
  fan: { turn_on: [], turn_off: [], toggle: [] },
  climate: { set_temperature: ["temperature"] },
  scene: { turn_on: [] },
  script: { turn_on: [] },
  lock: { lock: [], unlock: [] },
  cover: { open_cover: [], close_cover: [], stop_cover: [] },
  media_player: {
    media_play: [],
    media_pause: [],
    media_stop: [],
    media_next_track: [],
    media_previous_track: [],
    volume_set: ["volume_level"],
    volume_mute: ["is_volume_muted"],
    play_media: ["media_content_id", "media_content_type", "announce"],
    select_source: ["source"],
    join: ["group_members"],
    unjoin: [],
  },
  music_assistant: { play_media: ["media_id", "media_type"] },
};

const MEDIA_SERVICES: Record<string, string> = {
  media_play: "media_play",
  media_pause: "media_pause",
  media_stop: "media_stop",
  media_next: "media_next_track",
  media_previous: "media_previous_track",
};
const PLAYBACK: Record<string, string> = {
  play: "Resume playback",
  pause: "Pause playback",
  stop: "Stop playback",
  next: "Next track",
  previous: "Previous track",
};
const KNOWN_MEDIA = /^(media-source:\/\/|spotify:)/;
const UNAVAILABLE = ["unknown", "unavailable"];

const READ_NAMES = ["ha_search_entities", "ha_get_registry", "home_status"];
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Verify that the state Home Assistant reports now is the one that was asked for. */
export function verifyState(
  plan: { service?: string; data?: Data; entity: HaState | HaEntity },
  state: HaState,
): boolean | null {
  const { service, data = {}, entity } = plan;
  const target = state.attributes || {};
  const num = (value: unknown) => Number(value);
  if (service === "turn_on")
    return (
      state.state === "on" &&
      (data.brightness_pct === undefined ||
        Math.abs(
          (num(target.brightness || 0) * 100) / 255 - num(data.brightness_pct),
        ) < 3) &&
      (data.rgb_color === undefined ||
        JSON.stringify(target.rgb_color) === JSON.stringify(data.rgb_color))
    );
  if (service === "turn_off") return state.state === "off";
  if (service === "toggle") return state.state !== entity.state;
  if (service === "set_temperature")
    return Math.abs(num(target.temperature) - num(data.temperature)) < 0.2;
  if (service === "volume_set")
    return Math.abs(num(target.volume_level) - num(data.volume_level)) < 0.02;
  if (service === "volume_mute")
    return target.is_volume_muted === data.is_volume_muted;
  if (service === "media_play") return state.state === "playing";
  if (service === "play_media") {
    if (state.state !== "playing") return false;
    const requested = data.media_content_id || data.media_id;
    if (target.media_content_id === requested) return true;
    if (
      typeof requested === "string" &&
      !KNOWN_MEDIA.test(requested) &&
      [
        target.media_title,
        target.media_artist,
        target.media_album_name,
        target.media_playlist,
      ].some(
        (value) =>
          typeof value === "string" &&
          value.toLowerCase().includes(requested.toLowerCase()),
      )
    )
      return true;
    return null;
  }
  if (service === "media_pause") return state.state === "paused";
  if (service === "media_stop") return ["idle", "off"].includes(state.state);
  if (["media_next_track", "media_previous_track"].includes(service ?? ""))
    return Boolean(
      target.media_content_id &&
      target.media_content_id !== entity.attributes?.media_content_id,
    );
  if (service === "join")
    return (
      Array.isArray(target.group_members) &&
      (data.group_members as string[]).every((id) =>
        (target.group_members as string[]).includes(id),
      )
    );
  if (service === "unjoin")
    return (
      !target.group_members || (target.group_members as unknown[]).length <= 1
    );
  if (service === "select_source") return target.source === data.source;
  if (service === "lock") return state.state === "locked";
  if (service === "unlock") return state.state === "unlocked";
  if (service === "open_cover") return state.state === "open";
  if (service === "close_cover") return state.state === "closed";
  return null;
}

const sanitizeState = (state: HaState) => ({
  entity_id: state.entity_id,
  state: state.state,
  attributes: state.attributes,
  last_updated: state.last_updated,
});

/** The Home Assistant tools: the real risk is decided in prepare, the effect checked in execute. */
@ToolSourceProvider()
export class HomeSource implements ToolSource {
  readonly source = "home-assistant";
  /** Pause between verification polls; tests shorten it. */
  verifyDelayMs = 400;

  constructor(
    private readonly home: HomeAssistantService,
    private readonly summary: HomeSummaryService,
    private readonly memory: SessionMemoryService,
    @Optional()
    @Inject(HOME_ALIAS_LOOKUP)
    private readonly aliases?: HomeAliasLookup,
  ) {}

  definitions(): ToolDefinition[] {
    const enabled = this.home.configured;
    const define = (
      name: string,
      description: string,
      properties: Record<string, unknown> = {},
      risk: ToolDefinition["risk"] = "READ_ONLY",
      required?: string[],
    ): Definition => ({
      name,
      description,
      parameters: schema(properties, required),
      risk,
      timeoutMs: 15000,
      enabled,
    });
    return [
      define(
        "home_status",
        "Overview of the house from Home Assistant: who is home, which lights and switches are on, thermostats, temperature sensors, updates, lists and media players, and which of those do not exist at all. Use it for questions like 'is er iemand thuis', 'welke lampen staan aan', 'hoe warm is het in huis' or 'wat staat er aan', instead of guessing entity names.",
        {},
        "READ_ONLY",
        [],
      ),
      define(
        "ha_search_entities",
        "Search actual Home Assistant entities by name, alias, domain or area. Use before selecting an unknown device.",
        { query: string, domain: string, area: string },
        "READ_ONLY",
        [],
      ),
      define(
        "ha_get_state",
        "Read fresh state of one actual Home Assistant entity. Context references require one unique recent entity.",
        target,
      ),
      define(
        "ha_get_registry",
        "Read actual Home Assistant entity, area and device registry; does not change devices.",
      ),
      define(
        "ha_call_service",
        "Call a backend-allowlisted installed Home Assistant service with structured data. Risk and confirmation are enforced by the backend.",
        {
          ...target,
          domain: string,
          service: string,
          data: { type: "object", maxProperties: 10 },
        },
        "SAFE",
        ["entity_id", "domain", "service"],
      ),
      define("ha_turn_on", "Turn on one actual device.", target, "SAFE"),
      define("ha_turn_off", "Turn off one actual device.", target, "SAFE"),
      define("ha_toggle", "Toggle one actual device.", target, "CONFIRM"),
      define(
        "ha_set_brightness",
        "Set a light brightness from 0 to 100 percent.",
        { ...target, brightness_pct: number(0, 100) },
        "SAFE",
      ),
      define(
        "ha_set_color",
        "Set a light RGB color. All three components range from 0 to 255.",
        {
          ...target,
          rgb_color: {
            type: "array",
            items: { type: "integer", minimum: 0, maximum: 255 },
            minItems: 3,
            maxItems: 3,
          },
        },
        "SAFE",
      ),
      define(
        "ha_set_temperature",
        "Set climate temperature in Celsius. Large changes require confirmation.",
        { ...target, temperature: number(5, 35) },
        "SAFE",
      ),
      define(
        "ha_activate_scene",
        "Activate an installed Home Assistant scene. Requires confirmation.",
        target,
        "CONFIRM",
      ),
      define(
        "ha_run_script",
        "Run an installed Home Assistant script. Requires confirmation.",
        target,
        "CONFIRM",
      ),
      define(
        "ha_bulk_turn_off",
        "Turn off an explicit list of actual entities. Always requires confirmation.",
        { entity_ids: idList(2, 50) },
        "CONFIRM",
      ),
      define(
        "media_set_volume",
        "Set media player volume from 0 to 1. Loud changes require confirmation.",
        { ...target, volume_level: number(0, 1) },
        "SAFE",
      ),
      define(
        "media_mute",
        "Set media player mute state.",
        { ...target, is_volume_muted: { type: "boolean" } },
        "SAFE",
      ),
      define(
        "sonos_group",
        "Group actual Sonos players with one actual coordinator; requires confirmation.",
        { ...target, group_members: idList(1, 20) },
        "CONFIRM",
      ),
      define(
        "sonos_ungroup",
        "Ungroup an actual Sonos player; requires confirmation.",
        target,
        "CONFIRM",
      ),
      define(
        "sonos_announce",
        "Announce a real media-source item or speak text using an installed Home Assistant TTS entity on Sonos. Requires confirmation.",
        {
          ...target,
          media_content_id: string,
          message: { type: "string", minLength: 1, maxLength: 500 },
          tts_entity_id: string,
        },
        "CONFIRM",
        ["entity_id"],
      ),
      define(
        "media_play_media",
        "Play an actual Spotify URI or installed Home Assistant media-source identifier through media_player.",
        {
          ...target,
          media_content_id: string,
          media_content_type: {
            type: "string",
            enum: ["music", "playlist", "album", "track", "radio"],
          },
        },
        "SAFE",
      ),
      define(
        "media_play_same",
        "Play the same known media source from the previous media target on another actual player. Unknown media identifiers are rejected.",
        target,
        "SAFE",
      ),
      define(
        "sonos_play_favorite",
        "Play an exact favorite exposed in the actual Sonos source list.",
        { ...target, source: string },
        "SAFE",
      ),
      define(
        "media_bulk_pause",
        "Pause an explicit list of actual media players; requires confirmation.",
        { entity_ids: idList(2, 50) },
        "CONFIRM",
      ),
      define(
        "sonos_favorites",
        "Read favorites exposed by an actual Sonos media player.",
        target,
      ),
      define(
        "music_play",
        "Play a library search or Spotify URI through installed Home Assistant Music Assistant. Never sends direct Spotify requests.",
        {
          ...target,
          media_id: string,
          media_type: {
            type: "string",
            enum: ["track", "album", "artist", "playlist", "radio"],
          },
        },
        "SAFE",
      ),
      ...Object.entries(PLAYBACK).map(([suffix, description]) =>
        define(
          `media_${suffix}`,
          `${description} on an actual Home Assistant media player.`,
          target,
          "SAFE",
        ),
      ),
    ];
  }

  async prepare(
    name: string,
    args: Args,
    call: ToolCall,
  ): Promise<ToolPlan | ToolPlanError> {
    call.signal.throwIfAborted();
    const definition = this.definitions().find((item) => item.name === name);
    if (!definition?.enabled)
      return { error: "Integration is not configured or tool is disabled" };
    try {
      await this.home.sync();
    } catch {
      return { error: "Home Assistant is not reachable" };
    }
    call.signal.throwIfAborted();
    if (READ_NAMES.includes(name)) return { args, risk: "READ_ONLY" };
    const context = this.memory.context(call.sessionId);
    if (name === "ha_bulk_turn_off" || name === "media_bulk_pause")
      return this.prepareBulk(name, args, context, call.signal);

    const requiredDomain =
      name.startsWith("media_") ||
      name.startsWith("sonos_") ||
      name === "music_play"
        ? "media_player"
        : name === "ha_set_temperature"
          ? "climate"
          : ["ha_set_brightness", "ha_set_color"].includes(name)
            ? "light"
            : name === "ha_activate_scene"
              ? "scene"
              : name === "ha_run_script"
                ? "script"
                : undefined;
    const reference = args.entity_id as string | undefined;
    let resolved = this.home.resolve(reference, context, requiredDomain);
    if (!("entity" in resolved) && !resolved.ambiguous && reference) {
      const related = await this.aliases?.relatedEntity(reference);
      if (related)
        resolved = this.home.resolve(related, context, requiredDomain);
    }
    if (!("entity" in resolved)) return failure(resolved);
    const entity: HaEntity = {
      ...resolved.entity,
      ...(await this.home.state(resolved.entity.entity_id, call.signal)),
    } as HaEntity;
    const normalized: Args = { ...args, entity_id: entity.entity_id };
    if (name === "ha_get_state" || name === "sonos_favorites")
      return {
        args: normalized,
        risk: "READ_ONLY",
        entity,
        data: { entity } satisfies Prepared,
      };
    if (UNAVAILABLE.includes(entity.state))
      return { error: "Target device is unavailable" };

    let domain = entity.domain;
    let service: string | undefined;
    let data: Data = {};
    if (name === "ha_call_service") {
      domain = args.domain as string;
      service = args.service as string;
      data = (args.data as Data | undefined) || {};
    } else if (name === "ha_set_brightness") {
      service = "turn_on";
      data.brightness_pct = args.brightness_pct;
    } else if (name === "ha_set_color") {
      service = "turn_on";
      data.rgb_color = args.rgb_color;
    } else if (name === "ha_set_temperature") {
      service = "set_temperature";
      data.temperature = args.temperature;
    } else if (name === "ha_activate_scene" || name === "ha_run_script")
      service = "turn_on";
    else if (name.startsWith("ha_")) service = name.replace("ha_", "");
    else if (name === "media_set_volume") {
      service = "volume_set";
      data.volume_level = args.volume_level;
    } else if (name === "media_mute") {
      service = "volume_mute";
      data.is_volume_muted = args.is_volume_muted;
    } else if (name === "media_play_media") {
      service = "play_media";
      data = {
        media_content_id: args.media_content_id,
        media_content_type: args.media_content_type,
      };
    } else if (name === "media_play_same") {
      if (!context.activeMediaTarget)
        return { error: "No previous media target is known" };
      const previous = this.home.resolve(
        context.activeMediaTarget,
        {},
        "media_player",
      );
      if (!("entity" in previous)) return failure(previous);
      const previousState = await this.home.state(
        previous.entity.entity_id,
        call.signal,
      );
      const id = previousState.attributes?.media_content_id;
      if (typeof id !== "string" || !KNOWN_MEDIA.test(id))
        return {
          error: "Previous player exposes no playable known media identifier",
        };
      service = "play_media";
      data = { media_content_id: id, media_content_type: "music" };
    } else if (name === "sonos_play_favorite") {
      const sources = entity.attributes?.source_list;
      if (!Array.isArray(sources) || !sources.includes(args.source))
        return { error: "Favorite is not exposed by this actual player" };
      service = "select_source";
      data.source = args.source;
    } else if (name.startsWith("media_")) service = MEDIA_SERVICES[name];
    else if (name === "sonos_group") {
      service = "join";
      const members: string[] = [];
      for (const member of args.group_members as string[]) {
        const found = this.home.resolve(member, context, "media_player");
        if (!("entity" in found)) return failure(found);
        members.push(found.entity.entity_id);
      }
      data.group_members = members;
      normalized.group_members = members;
    } else if (name === "sonos_ungroup") service = "unjoin";
    else if (name === "sonos_announce") {
      let content = args.media_content_id as string | undefined;
      if (args.message) {
        if (content || !args.tts_entity_id)
          return {
            error:
              "Text announcements require exactly one installed TTS entity and no media identifier",
          };
        const tts = this.home.resolve(args.tts_entity_id, {}, "tts");
        if (!("entity" in tts))
          return { error: "Requested TTS entity is not installed" };
        content = `media-source://tts/${tts.entity.entity_id}?message=${encodeURIComponent(String(args.message))}`;
      }
      if (!content) return { error: "Announcement content is required" };
      service = "play_media";
      data = {
        media_content_id: content,
        media_content_type: "music",
        announce: true,
      };
    } else if (name === "music_play") {
      domain = "music_assistant";
      service = "play_media";
      data = { media_id: args.media_id, media_type: args.media_type };
    }

    if (domain !== entity.domain && domain !== "music_assistant")
      return { error: "Service domain must match the actual target" };
    const allowed = service ? ALLOWED_SERVICES[domain]?.[service] : undefined;
    if (
      !service ||
      !allowed ||
      Object.keys(data).some((key) => !allowed.includes(key))
    )
      return { error: "Service or data field is not allowlisted" };
    if (
      name === "ha_call_service" &&
      ["join", "unjoin", "play_media"].includes(service)
    )
      return {
        error: "Use the dedicated media or grouping tool for this service",
      };
    if (
      (service === "set_temperature" && data.temperature === undefined) ||
      (service === "volume_set" && data.volume_level === undefined) ||
      (service === "volume_mute" && data.is_volume_muted === undefined)
    )
      return { error: "Required service data is missing" };
    // Generic service calls use the same strict value checks as named tools.
    if (invalidValues(data)) return { error: "Invalid service data values" };
    if (!this.home.hasService(domain, service))
      return {
        error:
          domain === "music_assistant"
            ? "Music Assistant is not installed; Spotify playback is unavailable"
            : "Home Assistant service is not installed",
      };
    if (
      name.startsWith("sonos_") &&
      !this.home.devices.some(
        (item) =>
          item.id === entity.device_id &&
          /sonos/i.test(item.manufacturer || ""),
      )
    )
      return { error: "Target is not a registered Sonos device" };
    if (
      service === "play_media" &&
      data.media_content_id &&
      !KNOWN_MEDIA.test(String(data.media_content_id))
    )
      return {
        error:
          "Use an installed media-source or Spotify identifier; arbitrary URLs are rejected",
      };

    const evaluated = actionRisk(domain, service, data, entity);
    const risk =
      evaluated === "DANGEROUS"
        ? "DANGEROUS"
        : definition.risk === "CONFIRM"
          ? "CONFIRM"
          : evaluated;
    return {
      args: normalized,
      risk,
      entity,
      data: { entity, domain, service, data } satisfies Prepared,
    };
  }

  private async prepareBulk(
    name: string,
    args: Args,
    context: ReturnType<SessionMemoryService["context"]>,
    signal: AbortSignal,
  ): Promise<ToolPlan | ToolPlanError> {
    const entities: HaEntity[] = [];
    const allowed =
      name === "media_bulk_pause"
        ? ["media_player"]
        : ["light", "switch", "fan"];
    for (const reference of args.entity_ids as string[]) {
      const resolved = this.home.resolve(reference, context);
      if (!("entity" in resolved)) return failure(resolved);
      if (!allowed.includes(resolved.entity.domain))
        return {
          error: "Bulk control supports only lights, switches and fans",
        };
      const fresh = {
        ...resolved.entity,
        ...(await this.home.state(resolved.entity.entity_id, signal)),
      } as HaEntity;
      if (UNAVAILABLE.includes(fresh.state))
        return { error: "A selected target is unavailable" };
      entities.push(fresh);
    }
    return {
      args: {
        entity_ids: [...new Set(entities.map((item) => item.entity_id))],
      },
      risk: entities.some(
        (item) => actionRisk(item.domain, "turn_off", {}, item) === "DANGEROUS",
      )
        ? "DANGEROUS"
        : "CONFIRM",
      data: { entities } satisfies Prepared,
    };
  }

  async execute(
    name: string,
    args: Args,
    call: ToolCall & { plan?: ToolPlan },
  ): Promise<ToolResult> {
    call.signal.throwIfAborted();
    const plan = (call.plan?.data ?? {}) as Prepared;
    if (name === "home_status") {
      const entities = await this.home.sync();
      return { ok: true, result: this.summary.describe(entities) };
    }
    if (name === "ha_search_entities")
      return {
        ok: true,
        result: this.home.search(
          args.query as string | undefined,
          args.domain as string | undefined,
          args.area as string | undefined,
        ),
      };
    if (name === "ha_get_registry")
      return {
        ok: true,
        result: {
          entities: this.home.entities,
          areas: this.home.areas,
          devices: this.home.devices,
          syncedAt: this.home.syncedAt,
        },
      };
    const entityId = args.entity_id as string;
    if (name === "ha_get_state")
      return {
        ok: true,
        result: await this.home.state(entityId, call.signal),
      };
    if (name === "sonos_favorites") {
      const state = await this.home.state(entityId, call.signal);
      return {
        ok: true,
        result: state.attributes?.source_list || [],
        note: "Only favorites exposed by Home Assistant are available",
      };
    }
    if (name === "ha_bulk_turn_off" || name === "media_bulk_pause")
      return this.executeBulk(name, plan.entities ?? [], call.signal);
    if (!plan.entity || !plan.domain || !plan.service)
      return { ok: false, error: "Tool call was not prepared" };
    return this.run(
      plan.entity,
      plan.domain,
      plan.service,
      plan.data ?? {},
      call.signal,
    );
  }

  private async executeBulk(
    name: string,
    entities: HaEntity[],
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const media = name === "media_bulk_pause";
    const results: (ToolResult & { entity_id: string })[] = [];
    for (const entity of entities) {
      try {
        const result = await this.run(
          entity,
          entity.domain,
          media ? "media_pause" : "turn_off",
          {},
          signal,
        );
        results.push({ entity_id: entity.entity_id, ...result });
      } catch {
        return {
          ok: false,
          accepted: results.some((item) => item.accepted),
          verified: false,
          status: "partial_or_timed_out",
          result: results,
          error:
            "Bulk action stopped; some targets may have completed. Check their current state.",
        };
      }
    }
    return {
      ok: results.every((item) => item.ok),
      accepted: results.every((item) => item.accepted),
      verified: results.every((item) => item.verified === true),
      result: results,
    };
  }

  /** Call the service, then look at Home Assistant to see whether the effect is really there. */
  private async run(
    entity: HaEntity,
    domain: string,
    service: string,
    data: Data,
    signal: AbortSignal,
  ): Promise<ToolResult> {
    const entityId = entity.entity_id;
    const before = await this.home.state(entityId, signal);
    await this.home.service(
      domain,
      service,
      { entity_id: entityId, ...data },
      signal,
    );
    if (
      ["scene", "script"].includes(entity.domain) ||
      data.announce ||
      service === "stop_cover"
    )
      return {
        ok: true,
        accepted: true,
        verified: null,
        status: "accepted_unverified",
        note: "This service exposes no reliable completion state",
      };
    for (let attempt = 0; attempt < 4; attempt++) {
      if (attempt) await sleep(this.verifyDelayMs);
      const state = await this.home.state(entityId, signal);
      const verified = verifyState({ service, data, entity: before }, state);
      if (verified === true)
        return {
          ok: true,
          accepted: true,
          verified: true,
          status: "verified",
          result: sanitizeState(state),
        };
      if (verified === null)
        return {
          ok: true,
          accepted: true,
          verified: null,
          status: "accepted_unverified",
        };
    }
    return {
      ok: false,
      accepted: true,
      verified: false,
      status: "verification_failed",
      error:
        "Home Assistant accepted the command, but the requested state was not observed",
    };
  }
}

/** A failed resolve (unknown, ambiguous, no unique recent target) as a tool error. */
function failure(resolved: Exclude<Resolved, { entity: HaEntity }>) {
  return resolved as ToolPlanError;
}

function invalidValues(data: Data): boolean {
  const { temperature, volume_level, brightness_pct, is_volume_muted } = data;
  const rgb = data.rgb_color;
  return (
    (temperature !== undefined &&
      (typeof temperature !== "number" ||
        temperature < 5 ||
        temperature > 35)) ||
    (volume_level !== undefined &&
      (typeof volume_level !== "number" ||
        volume_level < 0 ||
        volume_level > 1)) ||
    (brightness_pct !== undefined &&
      (typeof brightness_pct !== "number" ||
        brightness_pct < 0 ||
        brightness_pct > 100)) ||
    (is_volume_muted !== undefined && typeof is_volume_muted !== "boolean") ||
    (rgb !== undefined &&
      (!Array.isArray(rgb) ||
        rgb.length !== 3 ||
        rgb.some(
          (value) => !Number.isInteger(value) || value < 0 || value > 255,
        )))
  );
}

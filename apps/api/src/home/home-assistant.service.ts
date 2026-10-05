import {
  Injectable,
  Logger,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { HaEntity, HomeHealth } from "@nova/contracts";
import WebSocket from "ws";
import { NovaConfig } from "../core/config/nova-config.js";
import { sanitize } from "../core/security/sanitize.js";

/** Lower-case, no accents, `_` and `-` as spaces: how names are compared. */
export const fold = (value: unknown): string =>
  String(value || "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .replace(/[_-]/g, " ")
    .trim();

export interface HaState {
  entity_id: string;
  state: string;
  attributes?: Record<string, unknown>;
  last_updated?: string;
  last_changed?: string;
}
export interface HaServiceInfo {
  domain: string;
  services: Record<string, unknown>;
}
export interface HaDevice {
  id: string;
  name?: string;
  name_by_user?: string;
  manufacturer?: string;
  area_id?: string | null;
}
export interface HaArea {
  area_id: string;
  name: string;
}
interface HaRegistryEntry {
  entity_id: string;
  name?: string;
  device_id?: string | null;
  area_id?: string | null;
  aliases?: string[];
}

/** What the conversation is currently about, for "die", "it", "dezelfde". */
export interface ResolveContext {
  activeEntities?: string[];
  activeMediaTarget?: string | null;
}

export type Resolved =
  | { entity: HaEntity }
  | {
      error: string;
      hint?: string;
      ambiguous?: boolean;
      candidates?: { entity_id: string; name: string; area: string | null }[];
    };

const REGISTRY_COMMANDS = [
  "config/entity_registry/list",
  "config/device_registry/list",
  "config/area_registry/list",
] as const;
const CACHE_MS = 60_000;
const ONLINE_MS = 120_000;
const REQUEST_TIMEOUT_MS = 8000;
const CONTEXT_WORDS = ["die", "dat", "het", "them", "it", "dezelfde", "same"];

/**
 * Home Assistant: REST for states and services, WebSocket for the registries. Keeps a catalog
 * of every entity (with area, device and aliases) that is refreshed every minute, and resolves
 * names to real entities without ever inventing one.
 */
@Injectable()
export class HomeAssistantService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger("HOME");
  private readonly url: string;
  private readonly token: string;
  private timer: NodeJS.Timeout | undefined;
  private refreshing: Promise<HaEntity[]> | null = null;

  entities: HaEntity[] = [];
  areas: HaArea[] = [];
  devices: HaDevice[] = [];
  services: HaServiceInfo[] = [];
  syncedAt: string | null = null;
  error: string | null = null;

  constructor(config: NovaConfig) {
    this.url = (config.homeAssistant.url || "").replace(/\/$/, "");
    this.token = config.homeAssistant.token || "";
  }

  get configured(): boolean {
    return Boolean(this.url && this.token && this.token !== "CHANGE_ME");
  }

  onModuleInit(): void {
    if (!this.configured) return;
    const refresh = () =>
      void this.sync(true).catch((error: Error) =>
        this.log.warn(`catalog sync failed: ${error.message}`),
      );
    refresh();
    this.timer = setInterval(refresh, CACHE_MS);
    this.timer.unref();
  }

  onModuleDestroy(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async request<T = unknown>(
    endpoint: string,
    method = "GET",
    body?: unknown,
    signal?: AbortSignal,
  ): Promise<T> {
    if (!this.configured)
      throw new Error("Home Assistant onboarding or token is missing");
    if (!endpoint.startsWith("/api/"))
      throw new Error("Invalid Home Assistant endpoint");
    const timeout = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const response = await fetch(`${this.url}${endpoint}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        "content-type": "application/json",
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok)
      throw new Error(`Home Assistant unavailable (${response.status})`);
    return (response.status === 204 ? null : await response.json()) as T;
  }

  /** Entity, device and area registries, over the WebSocket API. */
  registries(): Promise<Record<(typeof REGISTRY_COMMANDS)[number], unknown>> {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(
        `${this.url.replace(/^http/, "ws")}/api/websocket`,
      );
      const answers: Record<string, unknown> = {};
      let settled = false;
      const timer = setTimeout(
        () => finish(new Error("Home Assistant registry timeout")),
        REQUEST_TIMEOUT_MS,
      );
      const finish = (error?: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        socket.close();
        if (error) reject(error);
        else resolve(answers as never);
      };
      socket.on("error", () =>
        finish(new Error("Home Assistant registry unavailable")),
      );
      socket.on("close", () =>
        finish(new Error("Home Assistant registry disconnected")),
      );
      socket.on("message", (raw) => {
        try {
          const message = JSON.parse(String(raw)) as {
            type?: string;
            id?: number;
            success?: boolean;
            result?: unknown;
          };
          if (message.type === "auth_required")
            socket.send(
              JSON.stringify({ type: "auth", access_token: this.token }),
            );
          if (message.type === "auth_invalid")
            finish(new Error("Home Assistant token rejected"));
          if (message.type === "auth_ok")
            REGISTRY_COMMANDS.forEach((type, index) =>
              socket.send(JSON.stringify({ id: index + 1, type })),
            );
          if (
            message.type === "result" &&
            typeof message.id === "number" &&
            message.id >= 1 &&
            message.id <= 3
          ) {
            if (!message.success)
              return finish(
                new Error("Home Assistant registry access rejected"),
              );
            answers[REGISTRY_COMMANDS[message.id - 1]!] = message.result;
            if (Object.keys(answers).length === 3) finish();
          }
        } catch {
          finish(new Error("Invalid Home Assistant registry response"));
        }
      });
    });
  }

  /** Refresh the catalog (at most once a minute unless forced). Throws when Home Assistant fails. */
  async sync(force = false): Promise<HaEntity[]> {
    if (
      !force &&
      this.syncedAt &&
      Date.now() - Date.parse(this.syncedAt) < CACHE_MS
    )
      return this.entities;
    if (this.refreshing) return this.refreshing;
    this.refreshing = (async () => {
      try {
        const [states, services, registries] = await Promise.all([
          this.request<HaState[]>("/api/states"),
          this.request<HaServiceInfo[]>("/api/services"),
          this.registries(),
        ]);
        this.areas = registries["config/area_registry/list"] as HaArea[];
        this.devices = registries["config/device_registry/list"] as HaDevice[];
        this.services = services;
        const entries = new Map(
          (registries["config/entity_registry/list"] as HaRegistryEntry[]).map(
            (item) => [item.entity_id, item],
          ),
        );
        const syncedAt = (this.syncedAt = new Date().toISOString());
        this.entities = states.map((state) => {
          const entry = entries.get(state.entity_id);
          const device = this.devices.find(
            (item) => item.id === entry?.device_id,
          );
          const areaId = entry?.area_id || device?.area_id;
          return sanitize({
            ...state,
            attributes: state.attributes ?? {},
            domain: state.entity_id.split(".")[0] ?? "",
            friendly_name:
              (state.attributes?.friendly_name as string | undefined) ||
              entry?.name ||
              state.entity_id,
            area_id: areaId || null,
            area:
              this.areas.find((item) => item.area_id === areaId)?.name || null,
            device_id: entry?.device_id || null,
            device: device?.name_by_user || device?.name || null,
            aliases: entry?.aliases || [],
            capabilities: Object.keys(state.attributes || {}),
            supported_features:
              (state.attributes?.supported_features as number | undefined) || 0,
            synced_at: syncedAt,
            last_seen: syncedAt,
          }) as HaEntity;
        });
        this.error = null;
        return this.entities;
      } catch (error) {
        this.error = (error as Error).message;
        throw error;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }

  search(query = "", domain?: string, area?: string): HaEntity[] {
    const words = fold(query).split(/\s+/).filter(Boolean);
    return this.entities
      .filter(
        (entity) =>
          (!domain || entity.domain === domain) &&
          (!area || fold(entity.area) === fold(area)) &&
          words.every((word) =>
            fold(
              [
                entity.entity_id,
                entity.friendly_name,
                entity.area,
                entity.device,
                ...entity.aliases,
              ].join(" "),
            ).includes(word),
          ),
      )
      .slice(0, 50);
  }

  /** Name (or entity id, alias, "die") to exactly one real entity, or why that is not possible. */
  resolve(
    reference: unknown,
    context: ResolveContext = {},
    domain?: string,
  ): Resolved {
    if (!reference || CONTEXT_WORDS.includes(fold(reference))) {
      const ids =
        domain === "media_player"
          ? [context.activeMediaTarget].filter(Boolean)
          : (context.activeEntities ?? []);
      const found = this.entities.filter(
        (item) =>
          ids.includes(item.entity_id) && (!domain || item.domain === domain),
      );
      return found.length === 1
        ? { entity: found[0]! }
        : { error: "No unique recent target. Ask which device." };
    }
    const exact = this.entities.filter(
      (item) =>
        (!domain || item.domain === domain) &&
        [item.entity_id, item.friendly_name, ...item.aliases].some(
          (value) => fold(value) === fold(reference),
        ),
    );
    const candidates = exact.length
      ? exact
      : this.search(String(reference), domain);
    if (candidates.length === 1) return { entity: candidates[0]! };
    const guessed = domain || /^([a-z_]+)\./.exec(String(reference))?.[1];
    const available = candidates.length
      ? []
      : this.entities
          .filter((item) => !guessed || item.domain === guessed)
          .slice(0, 12)
          .map((item) => item.friendly_name || item.entity_id);
    return {
      error: candidates.length
        ? "Ambiguous target. Ask the user to choose."
        : "Unknown target. Never invent entity IDs.",
      ...(candidates.length
        ? {}
        : {
            hint: guessed
              ? available.length
                ? `Er is geen apparaat met die naam. Beschikbaar (${guessed}): ${available.join(", ")}. Kies hieruit of vraag welk apparaat bedoeld wordt.`
                : `Home Assistant heeft helemaal geen ${guessed}-apparaten. Zeg dat eerlijk en verzin er geen.`
              : "Zoek met ha_search_entities op een andere naam, of vraag welk apparaat bedoeld wordt.",
          }),
      ambiguous: candidates.length > 1,
      candidates: candidates.map((item) => ({
        entity_id: item.entity_id,
        name: item.friendly_name,
        area: item.area,
      })),
    };
  }

  hasService(domain: string, service: string): boolean {
    return this.services.some(
      (item) => item.domain === domain && Object.hasOwn(item.services, service),
    );
  }

  async service(
    domain: string,
    service: string,
    data: Record<string, unknown>,
    signal?: AbortSignal,
  ): Promise<unknown> {
    if (!this.hasService(domain, service))
      throw new Error("Service is not installed in Home Assistant");
    return this.request(
      `/api/services/${encodeURIComponent(domain)}/${encodeURIComponent(service)}`,
      "POST",
      data,
      signal,
    );
  }

  state(entityId: string, signal?: AbortSignal): Promise<HaState> {
    return this.request<HaState>(
      `/api/states/${encodeURIComponent(entityId)}`,
      "GET",
      undefined,
      signal,
    );
  }

  health(): HomeHealth {
    const age = this.syncedAt ? Date.now() - Date.parse(this.syncedAt) : null;
    return {
      configured: this.configured,
      online: Boolean(age !== null && !this.error && age < ONLINE_MS),
      stale: age === null || age >= ONLINE_MS,
      syncedAt: this.syncedAt,
      entities: this.entities.length,
      sonos:
        this.services.some((item) => item.domain === "sonos") ||
        this.devices.some((item) => /sonos/i.test(item.manufacturer || "")),
      musicAssistant: this.services.some(
        (item) => item.domain === "music_assistant",
      ),
      error: this.error,
    };
  }
}

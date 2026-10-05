import { Injectable } from "@nestjs/common";
import type {
  AirNow,
  HaEntity,
  OverviewResponse,
  SunNow,
  WeatherNow,
} from "@nova/contracts";
import { sanitize } from "../core/security/sanitize.js";
import { ChecksService } from "../checks/checks.service.js";
import { HomeAssistantService } from "../home/home-assistant.service.js";
import { homeSummary } from "../home/home-summary.service.js";
import { WorldService } from "../integrations/world/world.service.js";
import { PlanningService } from "../planning/planning.service.js";
import { ProxmoxService } from "../proxmox/proxmox.service.js";

const weatherFrom = (entities: HaEntity[]): Omit<WeatherNow, "forecast"> => {
  const entity = entities.find((item) => item.domain === "weather");
  if (!entity) return {};
  const a = entity.attributes ?? {};
  return {
    name: entity.friendly_name,
    condition: entity.state,
    temperature: (a.temperature as number | undefined) ?? null,
    temperatureUnit: (a.temperature_unit as string | undefined) ?? "°C",
    humidity: (a.humidity as number | undefined) ?? null,
    windSpeed: (a.wind_speed as number | undefined) ?? null,
    windUnit: (a.wind_speed_unit as string | undefined) ?? "km/h",
    pressure: (a.pressure as number | undefined) ?? null,
  };
};

const sunFrom = (entities: HaEntity[]): SunNow | null => {
  const entity = entities.find((item) => item.entity_id === "sun.sun");
  if (!entity) return null;
  const a = entity.attributes ?? {};
  return {
    aboveHorizon: entity.state === "above_horizon",
    elevation: (a.elevation as number | undefined) ?? null,
    azimuth: (a.azimuth as number | undefined) ?? null,
    nextRising: (a.next_rising as string | undefined) ?? null,
    nextSetting: (a.next_setting as string | undefined) ?? null,
  };
};

/** Remembers the last answer for a while, and never lets a slow source break the page. */
function slow<T>(
  load: () => Promise<T>,
  ttlMs: number,
): () => Promise<T | null> {
  let value: T | null = null;
  let at = 0;
  return async () => {
    if (Date.now() - at < ttlMs) return value;
    try {
      value = await load();
    } catch {
      value = null;
    }
    at = Date.now();
    return value;
  };
}

/**
 * Everything the side panels show, assembled from the services that own the data. One cached answer
 * (5 s) is shared by all viewers, and a source that fails shows up as null instead of an error.
 */
@Injectable()
export class OverviewService {
  private cache: OverviewResponse | null = null;
  private cacheAt = 0;
  private inflight: Promise<OverviewResponse> | null = null;

  private readonly forecast = slow(async () => {
    const forecast = await this.world.homeForecast();
    return forecast
      ? {
          place: forecast.location.name,
          hours: forecast.nextHours.map((hour) => ({
            time: hour.time,
            temperature: hour.temperature,
            rainChancePercent: hour.rainChancePercent,
          })),
        }
      : null;
  }, 10 * 60_000);

  private readonly air = slow(async (): Promise<AirNow | null> => {
    await this.world.ready();
    const home = this.world.home();
    if (!home) return null;
    const air = await this.world.airQuality({ ...home, name: "thuis" });
    return {
      aqi: air.aqi,
      uv: air.uv,
      pm25: air.pm25,
      pollen: air.pollen.highest,
      summary: air.summary,
    };
  }, 15 * 60_000);

  private readonly markets = slow(() => this.world.markets(), 5 * 60_000);
  private readonly iss = slow(() => this.world.iss(), 8_000);

  private readonly news = slow(async () => {
    const result = await this.world.execute("news_headlines", { count: 4 });
    const items = (
      result.result as
        | { items?: { title: string; link: string; published: string }[] }
        | undefined
    )?.items;
    return result.ok && items
      ? items.map((item) => ({
          title: item.title,
          link: item.link,
          published: item.published,
        }))
      : null;
  }, 10 * 60_000);

  constructor(
    private readonly proxmox: ProxmoxService,
    private readonly planning: PlanningService,
    private readonly checks: ChecksService,
    private readonly home: HomeAssistantService,
    private readonly world: WorldService,
  ) {}

  async overview(now = Date.now(), maxAgeMs = 5000): Promise<OverviewResponse> {
    if (this.cache && now - this.cacheAt < maxAgeMs) return this.cache;
    this.inflight ??= this.build()
      .then((value) => {
        this.cache = value;
        this.cacheAt = Date.now();
        return value;
      })
      .finally(() => {
        this.inflight = null;
      });
    return this.inflight;
  }

  private async build(): Promise<OverviewResponse> {
    const settle = <T>(promise: Promise<T>) =>
      promise.then(
        (value) => value,
        () => null,
      );
    const [guests, storage, entities, forecast, news, air, markets, iss] =
      await Promise.all([
        this.proxmox.configured
          ? settle(this.proxmox.guests())
          : Promise.resolve(null),
        this.proxmox.configured
          ? settle(this.proxmox.storage())
          : Promise.resolve(null),
        this.home.configured ? settle(this.home.sync()) : Promise.resolve(null),
        this.forecast(),
        this.news(),
        this.air(),
        this.markets(),
        this.iss(),
      ]);
    const timers = settle(Promise.resolve(this.planning.timers()));
    const lists = settle(Promise.resolve(this.planning.lists()));
    const alerts = settle(Promise.resolve(this.checks.alerts()));
    return sanitize({
      at: new Date().toISOString(),
      proxmox:
        guests || storage
          ? { guests: guests ?? [], storage: storage ?? [] }
          : null,
      weather: entities ? { ...weatherFrom(entities), forecast } : null,
      sun: entities ? sunFrom(entities) : null,
      news,
      timers: await timers,
      lists: await lists,
      alerts: await alerts,
      home: entities ? homeSummary(entities) : null,
      air,
      markets,
      iss,
      moon: this.world.moon(),
    });
  }
}

import { Inject, Injectable, Optional } from "@nestjs/common";
import type {
  AirQuality,
  IssPosition,
  MarketRates,
  MoonPhase,
  WeatherForecast,
  WorldPlace,
} from "@nova/contracts";
import type { ToolResult } from "../../tools/tool.types.js";
import { NovaConfig } from "../../core/config/nova-config.js";
import {
  fetchPublic,
  type FetchPublicOptions,
  type PublicResponse,
} from "../../core/security/net-guard.js";
import { airQuality } from "./air.js";
import { issPosition, moonPhase } from "./astronomy.js";
import { calculate } from "./calculate.js";
import { geocode } from "./geo.js";
import {
  HOME_LOCATION_FILE,
  recallHome,
  rememberHome,
  type HomeLocation,
} from "./home.js";
import { convertCurrency, markets } from "./markets.js";
import { newsHeadlines, parseNewsFeeds } from "./news.js";
import { forecast } from "./weather.js";
import { routeEstimate } from "./route.js";
import type { CalDavService } from "../../planning/caldav.service.js";
import { calendarEventStartInstant } from "../../planning/calendar-day.js";
import { webRead, webSearch, wikipedia } from "./web.js";
import { WORLD_HTTP, type HomeSource, type WorldHttp } from "./world.types.js";

const MAX_FIXED_JSON_BYTES = 1_500_000;
const FIXED_JSON_HOSTS = new Set([
  "air-quality-api.open-meteo.com",
  "api.coingecko.com",
  "api.frankfurter.dev",
  "api.open-meteo.com",
  "api.wheretheiss.at",
  "de.wikipedia.org",
  "en.wikipedia.org",
  "fr.wikipedia.org",
  "geocoding-api.open-meteo.com",
  "nl.wikipedia.org",
]);

function assertFixedJsonUrl(value: string): void {
  const url = new URL(value);
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.port && url.port !== "443") ||
    !FIXED_JSON_HOSTS.has(url.hostname.toLowerCase())
  )
    throw new Error("Blocked: JSON service URL is not in the fixed allowlist");
}

async function jsonWithLimit<T>(response: Response): Promise<T> {
  const declaredLength = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredLength) && declaredLength > MAX_FIXED_JSON_BYTES)
    throw new Error("Response too large");
  const reader = response.body?.getReader();
  if (!reader) {
    const body = await response.text();
    if (Buffer.byteLength(body) > MAX_FIXED_JSON_BYTES)
      throw new Error("Response too large");
    return JSON.parse(body) as T;
  }
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_FIXED_JSON_BYTES) {
      await reader.cancel().catch(() => {});
      throw new Error("Response too large");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as T;
}

/** The real network: fixed APIs through fetch, anything model-controlled through the net guard. */
export const defaultWorldHttp: WorldHttp = {
  async getJson<T>(url: string, signal?: AbortSignal): Promise<T> {
    assertFixedJsonUrl(url);
    const response = await fetch(url, {
      signal: signal ?? AbortSignal.timeout(10000),
      redirect: "error",
      headers: {
        accept: "application/json",
        "user-agent": "NOVA/1.0 (private assistant)",
      },
    });
    if (!response.ok) throw new Error(`Request failed (${response.status})`);
    return jsonWithLimit<T>(response);
  },
  async getPage(
    url: string,
    options?: FetchPublicOptions,
  ): Promise<PublicResponse> {
    const response = await fetchPublic(url, options);
    if (response.status >= 400)
      throw new Error(`Page returned ${response.status}`);
    return response;
  },
};

export type WorldToolResult = ToolResult;

/**
 * What NOVA knows about the world outside the house. Read-only and keyless. The dashboard
 * uses homeForecast, airQuality, markets, iss and news; the tools go through execute.
 */
@Injectable()
export class WorldService {
  private readonly http: WorldHttp;
  private zone: HomeSource | null = null;

  constructor(
    private readonly config: NovaConfig,
    @Optional() @Inject(WORLD_HTTP) http?: WorldHttp,
  ) {
    this.http = http ?? defaultWorldHttp;
  }

  /** The Home Assistant module registers itself here, so "home" follows zone.home. */
  useHomeSource(source: HomeSource | null): void {
    this.zone = source;
  }

  private get homeFile(): string {
    return this.config.dataFile(HOME_LOCATION_FILE);
  }

  /** Home Assistant may not have synced yet right after a restart. */
  async ready(): Promise<void> {
    await this.zone?.sync?.().catch(() => {});
  }

  /** Home: Home Assistant's zone.home, else the configured coordinates, else the saved copy. */
  home(): HomeLocation | null {
    const found = this.zone?.zoneHome();
    if (found) {
      rememberHome(found, this.homeFile);
      return found;
    }
    const configured = this.config.homeLocation;
    if (configured) return { ...configured, name: "thuis" };
    return recallHome(this.homeFile);
  }

  health(): { configured: boolean; home: boolean } {
    return { configured: true, home: this.home() !== null };
  }

  get routeEnabled(): boolean {
    return Boolean(this.config.openRouteServiceKey);
  }

  geocode(place: string, signal?: AbortSignal): Promise<WorldPlace> {
    return geocode(this.http, place, signal);
  }

  forecast(
    place: Parameters<typeof forecast>[1],
    days = 2,
    signal?: AbortSignal,
  ): Promise<WeatherForecast> {
    return forecast(this.http, place, days, signal);
  }

  /** The named place, or home. Throws a Dutch message when there is neither. */
  async placeFor(location?: string, signal?: AbortSignal): Promise<WorldPlace> {
    if (location) return this.geocode(location, signal);
    await this.ready();
    const home = this.home();
    if (!home) throw new Error("Geen thuislocatie bekend. Noem een plaats.");
    return { ...home, name: "bij jou thuis", region: null, country: null };
  }

  airQuality(
    place: { latitude: number; longitude: number; name: string },
    signal?: AbortSignal,
  ): Promise<AirQuality> {
    return airQuality(this.http, place, signal);
  }

  markets(signal?: AbortSignal): Promise<MarketRates> {
    return markets(this.http, signal);
  }

  iss(signal?: AbortSignal): Promise<IssPosition> {
    return issPosition(
      this.http,
      async () => {
        await this.ready();
        return this.home();
      },
      signal,
    );
  }

  moon(date?: Date): MoonPhase {
    return moonPhase(date);
  }

  /** Two-day forecast at home, or null while home is unknown. */
  async homeForecast(signal?: AbortSignal): Promise<WeatherForecast | null> {
    await this.ready();
    const home = this.home();
    return home ? this.forecast(home, 2, signal) : null;
  }

  async execute(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    calendar?: CalDavService,
  ): Promise<WorldToolResult> {
    try {
      return await this.run(name, args, signal, calendar);
    } catch (error) {
      const failure = error as { name?: string; message?: unknown };
      const message =
        typeof failure?.message === "string" ? failure.message : "";
      const known =
        /^Request failed \([1-5][0-9]{2}\)$/.test(message) ||
        /^Page returned [1-5][0-9]{2}$/.test(message) ||
        /^Niet-leesbaar paginatype: [a-zA-Z0-9.+-]+\/[a-zA-Z0-9.+-]+$/.test(
          message,
        ) ||
        /^Onbekende valuta: [A-Z]{3} of [A-Z]{3}$/.test(message) ||
        [
          "Response too large",
          "Geen thuislocatie bekend. Noem een plaats.",
          "Geen koersen beschikbaar",
          "De pagina bevat geen leesbare tekst.",
        ].includes(message);
      return {
        ok: false,
        error:
          failure?.name === "AbortError" || failure?.name === "TimeoutError"
            ? "Tijdslimiet bereikt"
            : message.startsWith("Plaats niet gevonden:")
              ? "Plaats niet gevonden."
              : known
                ? message
                : "Externe dienst niet beschikbaar.",
      };
    }
  }

  private async run(
    name: string,
    args: Record<string, unknown>,
    signal?: AbortSignal,
    calendar?: CalDavService,
  ): Promise<WorldToolResult> {
    const str = (key: string) => args[key] as string;
    switch (name) {
      case "weather_forecast": {
        const location = args.location as string | undefined;
        const place = await this.placeFor(location, signal);
        return {
          ok: true,
          result: await this.forecast(
            place,
            (args.days as number | undefined) ?? 1,
            signal,
          ),
        };
      }
      case "web_search": {
        const results = await webSearch(
          this.http,
          str("query"),
          (args.maxResults as number | undefined) ?? 5,
          signal,
        );
        if (!results.length)
          return { ok: false, error: "Geen zoekresultaten gevonden." };
        return {
          ok: true,
          result: {
            query: args.query,
            untrusted: true,
            results,
            hint: 'Beantwoord de vraag zelf in een of twee zinnen en noem de bron ("volgens ..."). Geen lijst met links, tenzij erom gevraagd wordt.',
          },
        };
      }
      case "web_read":
        return {
          ok: true,
          result: await webRead(this.http, str("url"), signal),
        };
      case "wikipedia": {
        const language = (args.language as string | undefined) ?? "nl";
        const result = await wikipedia(
          this.http,
          str("query"),
          language,
          signal,
        );
        if (!result)
          return {
            ok: false,
            error: `Niets gevonden op Wikipedia (${language}) voor "${args.query}".`,
          };
        return { ok: true, result };
      }
      case "news_headlines": {
        const topic = (args.topic as string | undefined) ?? "algemeen";
        const result = await newsHeadlines(
          this.http,
          topic,
          (args.count as number | undefined) ?? 4,
          signal,
          parseNewsFeeds(this.config.newsFeeds || ""),
        );
        if (!result)
          return { ok: false, error: "Geen nieuwsberichten gevonden." };
        return { ok: true, result };
      }
      case "currency_convert":
        return {
          ok: true,
          result: await convertCurrency(
            this.http,
            args.amount as number,
            str("from"),
            str("to"),
            signal,
          ),
        };
      case "air_quality":
        return {
          ok: true,
          result: await this.airQuality(
            await this.placeFor(args.location as string | undefined, signal),
            signal,
          ),
        };
      case "market_rates":
        return { ok: true, result: await this.markets(signal) };
      case "iss_position":
        return { ok: true, result: await this.iss(signal) };
      case "moon_phase":
        return {
          ok: true,
          result: {
            ...this.moon(),
            hint: "Zeg de fase en hoeveel er verlicht is. Noem de volgende volle maan alleen als erom gevraagd wordt.",
          },
        };
      case "calculate":
        return {
          ok: true,
          result: {
            expression: args.expression,
            value: calculate(str("expression")),
          },
        };
      case "route_estimate": {
        if (!this.routeEnabled)
          return { ok: false, error: "Routebron is niet ingesteld." };
        const origin = await this.placeFor(
          args.origin as string | undefined,
          signal,
        );
        const destination = await this.geocode(str("destination"), signal);
        return {
          ok: true,
          result: await routeEstimate(
            this.config.openRouteServiceKey,
            origin,
            destination,
            (args.mode as
              "driving-car" | "cycling-regular" | "foot-walking" | undefined) ??
              "driving-car",
            signal,
          ),
        };
      }
      case "calendar_departure": {
        if (!this.routeEnabled || !calendar?.configured)
          return { ok: false, error: "Route of agenda is niet ingesteld." };
        const appointments = (await calendar.upcoming()).filter(
          (event) => event.summary === str("summary"),
        );
        if (appointments.length !== 1)
          return { ok: false, error: "Afspraak niet eenduidig gevonden." };
        const appointment = appointments[0]!;
        const start = calendarEventStartInstant(
          appointment,
          this.config.timezone,
        );
        if (!start || start.getTime() <= Date.now())
          return {
            ok: false,
            error: "Afspraak heeft geen toekomstig begintijdstip.",
          };
        const origin = await this.placeFor(undefined, signal);
        const destination = await this.geocode(str("destination"), signal);
        const route = await routeEstimate(
          this.config.openRouteServiceKey,
          origin,
          destination,
          "driving-car",
          signal,
        );
        const requestedBuffer = args.bufferMinutes;
        const bufferMinutes =
          typeof requestedBuffer === "number" &&
          Number.isInteger(requestedBuffer) &&
          requestedBuffer >= 0 &&
          requestedBuffer <= 60
            ? requestedBuffer
            : 15;
        const leaveAt = new Date(
          start.getTime() - (route.durationMinutes + bufferMinutes) * 60_000,
        );
        return {
          ok: true,
          result: {
            appointmentAt: start.toISOString(),
            leaveAt: leaveAt.toISOString(),
            leaveNow: leaveAt.getTime() <= Date.now(),
            timeZone: this.config.timezone,
            bufferMinutes,
            route,
            note: "Vertrekadvies zonder actuele verkeersdrukte; controleer verkeer vlak voor vertrek.",
          },
        };
      }
      default:
        return { ok: false, error: "Unknown tool" };
    }
  }
}

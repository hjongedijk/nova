import fs from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import os from "node:os";
import path from "node:path";
import { Test } from "@nestjs/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { CoreModule } from "../../src/core/core.module.js";
import {
  isPrivateAddress,
  assertPublicUrl,
} from "../../src/core/security/net-guard.js";
import {
  aqiLabel,
  calculate,
  decodeEntities,
  describeWeather,
  distanceKm,
  firstSentence,
  htmlToText,
  moonPhase,
  parseDuckDuckGo,
  parseRss,
  recallHome,
  rememberHome,
  uvLabel,
  WorldModule,
  WorldService,
  WorldSource,
  WORLD_TOOL_NAMES,
  type HomeSource,
  type WorldHttp,
} from "../../src/integrations/world/index.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-world-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

type Reply = { status?: number; type?: string; body: unknown };

/** A local web server stands in for every external service; URLs are rewritten to it. */
describe("with a local web server", () => {
  let server: http.Server;
  let port = 0;
  let requests: string[] = [];
  let respond: (url: URL) => Reply = () => ({ status: 404, body: "" });

  beforeAll(async () => {
    server = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://local");
      requests.push(`${req.headers["x-original-host"]}${req.url}`);
      const reply = respond(url);
      res.writeHead(reply.status ?? 200, {
        "content-type": reply.type ?? "application/json",
      });
      res.end(
        typeof reply.body === "string"
          ? reply.body
          : JSON.stringify(reply.body),
      );
    });
    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    port = (server.address() as AddressInfo).port;
  });
  afterAll(() => new Promise((resolve) => server.close(resolve)));
  afterEach(() => {
    requests = [];
    respond = () => ({ status: 404, body: "" });
  });

  const local = (url: string) => {
    const target = new URL(url);
    return {
      url: `http://127.0.0.1:${port}${target.pathname}${target.search}`,
      headers: { "x-original-host": target.host },
    };
  };
  const network: WorldHttp = {
    async getJson<T>(url: string): Promise<T> {
      const { url: to, headers } = local(url);
      const response = await fetch(to, { headers });
      if (!response.ok) throw new Error(`Request failed (${response.status})`);
      return (await response.json()) as T;
    },
    async getPage(url) {
      const { url: to, headers } = local(url);
      const response = await fetch(to, { headers });
      if (response.status >= 400)
        throw new Error(`Page returned ${response.status}`);
      return {
        status: response.status,
        headers: Object.fromEntries(response.headers),
        body: await response.text(),
        url,
      };
    },
  };

  let counter = 0;
  const make = (options: { home?: HomeSource | null; lat?: number } = {}) => {
    const dataDir = path.join(dir, `data-${counter++}`);
    fs.mkdirSync(dataDir, { recursive: true });
    const config = {
      dataFile: (name: string) => path.join(dataDir, name),
      homeLocation: null,
    } as unknown as NovaConfig;
    const world = new WorldService(config, network);
    if (options.home) world.useHomeSource(options.home);
    return world;
  };
  const homeAt = (latitude: number, longitude: number): HomeSource => ({
    sync: async () => {},
    zoneHome: () => ({ latitude, longitude, name: "Thuis" }),
  });

  const forecastBody = {
    timezone: "Europe/Amsterdam",
    current: {
      time: "2026-10-04T15:00",
      temperature_2m: 17.6,
      apparent_temperature: 17,
      relative_humidity_2m: 65,
      precipitation: 0,
      weather_code: 3,
      wind_speed_10m: 6,
      wind_gusts_10m: 17,
      is_day: 1,
    },
    daily: {
      time: ["2026-10-04", "2026-10-05"],
      weather_code: [3, 61],
      temperature_2m_max: [18, 14],
      temperature_2m_min: [8, 9],
      precipitation_sum: [0, 3.2],
      precipitation_probability_max: [5, 80],
      sunrise: ["2026-10-04T07:45", "2026-10-05T07:47"],
      sunset: ["2026-10-04T19:06", "2026-10-05T19:04"],
    },
    hourly: {
      time: Array.from(
        { length: 30 },
        (_, i) => `2026-10-04T${String(i % 24).padStart(2, "0")}:00`,
      ),
      temperature_2m: Array.from({ length: 30 }, (_, i) => i),
      precipitation_probability: Array.from({ length: 30 }, () => 10),
      weather_code: Array.from({ length: 30 }, () => 3),
    },
  };

  it("weather_forecast geocodes a place and returns a compact Dutch forecast", async () => {
    respond = (url) =>
      url.pathname.includes("/v1/search")
        ? {
            body: {
              results: [
                {
                  name: "Akkrum",
                  admin1: "Friesland",
                  country: "Nederland",
                  latitude: 53.05,
                  longitude: 5.83,
                },
              ],
            },
          }
        : { body: forecastBody };
    const out = await make().execute("weather_forecast", {
      location: "Akkrum",
      days: 2,
    });
    expect(out.ok).toBe(true);
    const result = out.result as {
      location: { name: string };
      current: { condition: string };
      days: { condition: string; weekday: string }[];
      nextHours: { time: string }[];
      summary: { nu: string; dagen: string[] };
    };
    expect(result.location.name).toBe("Akkrum");
    expect(result.current.condition).toBe("bewolkt");
    expect(result.days[1]?.condition).toBe("lichte regen");
    expect(result.days[1]?.weekday).toBe("maandag");
    expect(result.nextHours).toHaveLength(12);
    expect(result.nextHours[0]?.time).toBe("15:00");
    expect(result.summary.nu).toBe("18° en bewolkt");
    expect(result.summary.dagen[0]).toBe("vandaag: 8° tot 18°, bewolkt");
    expect(result.summary.dagen[1]).toBe(
      "morgen: 9° tot 14°, lichte regen, 80% kans op regen",
    );
    expect(requests[0]).toMatch(/geocoding-api\.open-meteo\.com.*name=Akkrum/);
  });

  it("weather_forecast without a location uses home, or asks for one", async () => {
    respond = () => ({ body: forecastBody });
    const out = await make({ home: homeAt(53.05, 5.83) }).execute(
      "weather_forecast",
      {},
    );
    expect(out.ok).toBe(true);
    expect((out.result as { location: { name: string } }).location.name).toBe(
      "bij jou thuis",
    );
    const missing = await make().execute("weather_forecast", {});
    expect(missing.ok).toBe(false);
    expect(missing.error).toMatch(/Noem een plaats/);
  });

  it("an unknown place is a clear error, not a crash", async () => {
    respond = () => ({ body: { results: [] } });
    const out = await make().execute("weather_forecast", {
      location: "Qwertyzz",
    });
    expect(out.ok).toBe(false);
    expect(out.error).toMatch(/niet gevonden/);
  });

  it("a failing service becomes an error result", async () => {
    respond = () => ({ status: 500, body: "" });
    const out = await make({ home: homeAt(1, 2) }).execute(
      "weather_forecast",
      {},
    );
    expect(out).toEqual({ ok: false, error: "Request failed (500)" });
  });

  it("the zone.home location is cached in the data dir and used after a restart", async () => {
    const world = make({ home: homeAt(53.05, 5.83) });
    expect(world.home()).toEqual({
      latitude: 53.05,
      longitude: 5.83,
      name: "Thuis",
    });
    const file = (world as unknown as { homeFile: string }).homeFile;
    expect(path.basename(file)).toBe("home-location.json");
    expect(recallHome(file)?.latitude).toBe(53.05);
    world.useHomeSource(null);
    expect(world.home()).toEqual({
      latitude: 53.05,
      longitude: 5.83,
      name: "thuis",
    });
    expect(world.health()).toEqual({ configured: true, home: true });
  });

  it("web_search falls back to Wikipedia when the search page has no results", async () => {
    respond = (url) =>
      url.pathname.startsWith("/html")
        ? { type: "text/html", body: "<html>anomaly</html>" }
        : {
            body: {
              query: {
                search: [
                  {
                    title: "Neil Armstrong",
                    snippet: "Eerste <b>mens</b> op de maan",
                  },
                ],
              },
            },
          };
    const out = await make().execute("web_search", { query: "Armstrong" });
    expect(out.ok).toBe(true);
    const result = out.result as {
      untrusted: boolean;
      results: { url: string; snippet: string }[];
    };
    expect(result.untrusted).toBe(true);
    expect(result.results[0]?.url).toBe(
      "https://nl.wikipedia.org/wiki/Neil_Armstrong",
    );
    expect(result.results[0]?.snippet).toBe("Eerste mens op de maan");
  });

  it("web_search reports when nothing at all is found", async () => {
    respond = (url) =>
      url.pathname.startsWith("/html")
        ? { type: "text/html", body: "" }
        : { body: {} };
    const out = await make().execute("web_search", { query: "zzzz" });
    expect(out).toEqual({ ok: false, error: "Geen zoekresultaten gevonden." });
  });

  it("web_read refuses binary pages, truncates long text and flags it untrusted", async () => {
    const world = make();
    respond = () => ({ type: "application/pdf", body: "%PDF" });
    const binary = await world.execute("web_read", {
      url: "https://example.com/a.pdf",
    });
    expect(binary.ok).toBe(false);
    expect(binary.error).toMatch(/application\/pdf/);
    respond = () => ({
      type: "text/html",
      body: `<html><title>T</title><body><p>${"woord ".repeat(3000)}</p></body></html>`,
    });
    const long = await world.execute("web_read", {
      url: "https://example.com/",
    });
    expect(long.ok).toBe(true);
    const result = long.result as {
      truncated: boolean;
      untrusted: boolean;
      text: string;
      title: string;
    };
    expect(result.truncated).toBe(true);
    expect(result.untrusted).toBe(true);
    expect(result.text).toHaveLength(6000);
    expect(result.title).toBe("T");
    respond = () => ({ type: "text/html", body: "<html><body></body></html>" });
    const empty = await world.execute("web_read", {
      url: "https://example.com/",
    });
    expect(empty.error).toBe("De pagina bevat geen leesbare tekst.");
  });

  it("wikipedia, news, currency and calculate return structured results", async () => {
    respond = (url) => {
      if (url.pathname.startsWith("/feeds") || url.pathname.startsWith("/nos"))
        return {
          type: "application/rss+xml",
          body: "<rss><item><title>Nieuws</title><link>https://nos.nl/1</link></item></rss>",
        };
      if (url.search.includes("list=search"))
        return { body: { query: { search: [{ title: "Neil Armstrong" }] } } };
      if (url.pathname.includes("page/summary"))
        return {
          body: {
            title: "Neil Armstrong",
            description: "astronaut",
            extract: "Eerste mens op de maan.",
            content_urls: {
              desktop: { page: "https://nl.wikipedia.org/wiki/Neil_Armstrong" },
            },
          },
        };
      return { body: { date: "2026-10-02", rates: { USD: 1.1225 } } };
    };
    const world = make();
    const wiki = await world.execute("wikipedia", { query: "Armstrong" });
    expect((wiki.result as { summary: string }).summary).toBe(
      "Eerste mens op de maan.",
    );
    const news = await world.execute("news_headlines", {
      topic: "tech",
      count: 3,
    });
    expect(
      (news.result as { items: { title: string }[] }).items[0]?.title,
    ).toBe("Nieuws");
    expect(requests.some((r) => r.endsWith("/nosnieuwstech"))).toBe(true);
    const money = await world.execute("currency_convert", {
      amount: 250,
      from: "eur",
      to: "usd",
    });
    expect((money.result as { converted: number }).converted).toBe(280.63);
    const same = await world.execute("currency_convert", {
      amount: 5,
      from: "EUR",
      to: "eur",
    });
    expect((same.result as { converted: number }).converted).toBe(5);
    const calc = await world.execute("calculate", { expression: "17*23" });
    expect((calc.result as { value: number }).value).toBe(391);
    expect((await world.execute("calculate", { expression: "1/0" })).ok).toBe(
      false,
    );
  });

  it("wikipedia and news say so when there is nothing", async () => {
    respond = (url) =>
      url.pathname.startsWith("/nos")
        ? { type: "text/xml", body: "<rss></rss>" }
        : { body: { query: { search: [] } } };
    const world = make();
    expect((await world.execute("wikipedia", { query: "qq" })).error).toBe(
      'Niets gevonden op Wikipedia (nl) voor "qq".',
    );
    expect((await world.execute("news_headlines", {})).error).toBe(
      "Geen nieuwsberichten gevonden.",
    );
    respond = () => ({ body: { date: "x", rates: {} } });
    expect(
      (
        await world.execute("currency_convert", {
          amount: 1,
          from: "EUR",
          to: "XXX",
        })
      ).error,
    ).toBe("Onbekende valuta: EUR of XXX");
  });

  it("air_quality names the worst pollen only when there is some", async () => {
    const body = (grass: number) => ({
      current: {
        european_aqi: 25,
        pm2_5: 5.3,
        pm10: 9,
        uv_index: 4.2,
        alder_pollen: 0,
        birch_pollen: 3,
        grass_pollen: grass,
      },
    });
    const run = async (grass: number) => {
      respond = () => ({ body: body(grass) });
      return (await make({ home: homeAt(1, 2) }).execute("air_quality", {}))
        .result as {
        pollen: { highest: { name: string; label: string } };
        summary: string;
      };
    };
    const busy = await run(120);
    expect(busy.pollen.highest.name).toBe("gras");
    expect(busy.pollen.highest.label).toBe("hoog");
    expect(busy.summary).toBe(
      "luchtkwaliteit redelijk, UV matig, pollen: gras hoog",
    );
    expect((await run(0)).summary).toBe(
      "luchtkwaliteit redelijk, UV matig, pollen: berk laag",
    );
    const none = await make().execute("air_quality", {});
    expect(none.error).toMatch(/Noem een plaats/);
  });

  it("market_rates reports the change since the previous day and survives one source failing", async () => {
    const series = {
      rates: {
        "2026-10-01": { USD: 1.1, GBP: 0.85 },
        "2026-10-02": { USD: 1.122, GBP: 0.8466 },
      },
    };
    respond = (url) =>
      url.pathname.startsWith("/v1/20")
        ? { body: series }
        : { body: { bitcoin: { eur: 75737.4, eur_24h_change: 0.527 } } };
    const world = make();
    const out = (await world.execute("market_rates", {})).result as {
      eur: Record<string, { rate: number; changePercent: number }>;
      bitcoin: unknown;
    };
    expect(out.eur.USD?.rate).toBe(1.122);
    expect(out.eur.USD?.changePercent).toBe(2);
    expect(out.eur.GBP?.changePercent).toBe(-0.4);
    expect(out.bitcoin).toEqual({ eur: 75737, change24hPercent: 0.5 });
    respond = (url) =>
      url.pathname.startsWith("/v1/20")
        ? { body: series }
        : { status: 429, body: "" };
    const partial = (await world.markets()) as {
      bitcoin: unknown;
      eur: object;
    };
    expect(partial.bitcoin).toBeNull();
    expect(partial.eur).toHaveProperty("USD");
    respond = () => ({ status: 500, body: "" });
    expect((await world.execute("market_rates", {})).error).toBe(
      "Geen koersen beschikbaar",
    );
  });

  it("iss_position is in range only when the footprint covers home", async () => {
    const issAt = (latitude: number, longitude: number) => {
      respond = () => ({
        body: {
          latitude,
          longitude,
          altitude: 418.8,
          velocity: 27586.3,
          visibility: "daylight",
          footprint: 4500,
        },
      });
      return make({ home: homeAt(53, 5.8) }).iss();
    };
    const near = await issAt(52, 6);
    expect(near.inRangeOfHome).toBe(true);
    expect(near.altitudeKm).toBe(419);
    expect(near.speedKmh).toBe(27586);
    const far = await issAt(-10, 44);
    expect(far.inRangeOfHome).toBe(false);
    expect(far.distanceFromHomeKm as number).toBeGreaterThan(7000);
    respond = () => ({
      body: {
        latitude: 1,
        longitude: 1,
        altitude: 1,
        velocity: 1,
        visibility: "x",
        footprint: 9,
      },
    });
    expect((await make().iss()).distanceFromHomeKm).toBeNull();
  });

  it("the dashboard interface: homeForecast is null without home, a two-day forecast with it", async () => {
    respond = () => ({ body: forecastBody });
    expect(await make().homeForecast()).toBeNull();
    const forecast = await make({ home: homeAt(53, 5.8) }).homeForecast();
    expect(forecast?.days).toHaveLength(2);
    expect(forecast?.location.name).toBe("Thuis");
  });

  it("news stories are cut to one short sentence", async () => {
    const long = `${"Woord ".repeat(60)}einde. Nog meer.`;
    respond = () => ({
      type: "text/xml",
      body: `<rss><item><title>Kop</title><description>${long}</description><link>https://nos.nl/1</link></item></rss>`,
    });
    const out = (await make().execute("news_headlines", {})).result as {
      items: { summary: string }[];
      hint: string;
    };
    expect(out.items[0]?.summary.length).toBeLessThanOrEqual(182);
    expect(out.hint).toMatch(/geen opsomming/i);
  });
});

describe("pure helpers", () => {
  it("moon_phase needs no network", async () => {
    const world = new WorldService(
      {
        dataFile: (n: string) => path.join(dir, n),
        homeLocation: null,
      } as unknown as NovaConfig,
      {
        getJson: async () => {
          throw new Error("no network");
        },
        getPage: async () => {
          throw new Error("no network");
        },
      },
    );
    const out = await world.execute("moon_phase", {});
    expect(out.ok).toBe(true);
    expect(typeof (out.result as { name: string }).name).toBe("string");
  });

  it("private addresses are refused before any request", () => {
    for (const address of ["10.0.0.5", "127.0.0.1", "169.254.169.254", "::1"])
      expect(isPrivateAddress(address)).toBe(true);
    expect(isPrivateAddress("8.8.8.8")).toBe(false);
    for (const url of [
      "http://localhost/",
      "http://10.0.0.5/",
      "http://jarvis-api/",
    ])
      expect(() => assertPublicUrl(url)).toThrow();
  });

  it("web_read never reaches internal addresses (real net guard)", async () => {
    const world = new WorldService({
      dataFile: (n: string) => path.join(dir, n),
      homeLocation: null,
    } as unknown as NovaConfig);
    for (const url of [
      "http://10.0.0.5/",
      "http://localhost/",
      "http://jarvis-api/",
      "https://host.docker.internal/",
    ]) {
      const out = await world.execute("web_read", { url });
      expect(out.ok, url).toBe(false);
    }
  });

  it("calculate evaluates exactly and refuses anything that is not arithmetic", () => {
    expect(calculate("17 * 23")).toBe(391);
    expect(calculate("(2+3)^2/4")).toBe(6.25);
    expect(calculate("2^3^2")).toBe(512);
    expect(calculate("-5 + 2*3")).toBe(1);
    expect(calculate("sqrt(144) + 10 % 3")).toBe(13);
    expect(calculate("0,1 + 0,2")).toBe(0.3);
    expect(calculate("15% van 240")).toBe(36);
    expect(calculate("15 procent van 240")).toBe(36);
    expect(calculate("240 * 15%")).toBe(36);
    expect(calculate("50% of 80")).toBe(40);
    expect(calculate("200 + 10%")).toBe(200.1);
    expect(calculate("10 % 3")).toBe(1);
    expect(calculate("(7 + 3) % 4")).toBe(2);
    for (const bad of [
      "1/0",
      "process.exit()",
      "2**3",
      "constructor",
      "1 +",
      "(1+2",
      "1e999",
    ])
      expect(() => calculate(bad), bad).toThrow();
  });

  it("RSS items are decoded from CDATA and entities", () => {
    const xml = `<rss><channel><item><title><![CDATA[Kabinet &amp; Kamer]]></title>
    <description><![CDATA[Een <b>samenvatting</b>]]></description><link>https://nos.nl/a</link>
    <pubDate>Sun, 04 Oct 2026 12:00:00 +0200</pubDate></item><item><title>Tweede</title></item></channel></rss>`;
    const items = parseRss(xml, 5);
    expect(items).toHaveLength(2);
    expect(items[0]).toEqual({
      title: "Kabinet & Kamer",
      summary: "Een samenvatting",
      link: "https://nos.nl/a",
      published: "Sun, 04 Oct 2026 12:00:00 +0200",
    });
    expect(parseRss(xml, 1)).toHaveLength(1);
  });

  it("DuckDuckGo results are unwrapped, decoded and ads are skipped", () => {
    const html = `
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fallecijfers.nl%2Fakkrum%2F&amp;rut=1">Akkrum &amp; cijfers</a>
    <a class="result__snippet" href="x">Er wonen <b>3.210</b> inwoners</a>
    <a rel="nofollow" class="result__a" href="//duckduckgo.com/y.js?ad_domain=x.com&amp;u3=1">Advertentie</a>
    <a class="result__snippet" href="x">koop nu</a>`;
    expect(parseDuckDuckGo(html, 5)).toEqual([
      {
        title: "Akkrum & cijfers",
        url: "https://allecijfers.nl/akkrum/",
        snippet: "Er wonen 3.210 inwoners",
      },
    ]);
  });

  it("page text drops scripts and navigation and keeps the article", () => {
    const { title, text } = htmlToText(
      `<html><head><title>Akkrum &ndash; Wikipedia</title><script>evil()</script></head>
     <body><nav>Menu</nav><article><h1>Akkrum</h1><p>Dorp in <b>Friesland</b>.</p><script>x()</script></article></body></html>`,
    );
    expect(title).toBe("Akkrum – Wikipedia");
    expect(text).toMatch(/Akkrum\nDorp in Friesland\./);
    expect(text).not.toMatch(/Menu|evil|x\(\)/);
    expect(decodeEntities("&#65;&#x42;&euro;&unknown;")).toBe("AB€&unknown;");
  });

  it("the home location is remembered and only rewritten when it changes", () => {
    const file = path.join(dir, "home-test.json");
    expect(recallHome(file)).toBeNull();
    rememberHome({ latitude: 53.05, longitude: 5.83 }, file);
    expect(recallHome(file)).toEqual({
      latitude: 53.05,
      longitude: 5.83,
      name: "thuis",
    });
    const first = fs.statSync(file).mtimeMs;
    rememberHome({ latitude: 53.05, longitude: 5.83 }, file);
    expect(fs.statSync(file).mtimeMs).toBe(first);
    rememberHome({ latitude: 52.1, longitude: 4.3 }, file);
    expect(recallHome(file)?.latitude).toBe(52.1);
    fs.writeFileSync(file, "not json");
    expect(recallHome(file)).toBeNull();
  });

  it("weather codes are described in Dutch", () => {
    expect(describeWeather(0)).toBe("helder");
    expect(describeWeather(95)).toBe("onweer");
    expect(describeWeather(12345)).toBe("onbekend");
  });

  it("the moon follows the known reference phases", () => {
    const newMoon = moonPhase(new Date(Date.UTC(2000, 0, 6, 18, 14)));
    expect(newMoon.name).toBe("nieuwe maan");
    expect(newMoon.illuminationPercent).toBe(0);
    const full = moonPhase(new Date(Date.UTC(2000, 0, 21, 4, 40)));
    expect(full.name).toBe("volle maan");
    expect(full.illuminationPercent).toBeGreaterThanOrEqual(99);
    expect(moonPhase(new Date(Date.UTC(2000, 0, 13, 20, 0))).name).toBe(
      "eerste kwartier",
    );
    expect(moonPhase(new Date(Date.UTC(2026, 9, 18))).waxing).toBe(true);
    const next = moonPhase(new Date(Date.UTC(2026, 9, 4)));
    expect(
      Math.abs(Date.parse(next.nextFull) - Date.UTC(2026, 9, 26)),
    ).toBeLessThanOrEqual(86400000 * 1.5);
  });

  it("distances are great-circle kilometres", () => {
    const amsterdam = { latitude: 52.37, longitude: 4.89 };
    const paris = { latitude: 48.86, longitude: 2.35 };
    expect(Math.abs(distanceKm(amsterdam, paris) - 430)).toBeLessThan(15);
    expect(Math.round(distanceKm(amsterdam, amsterdam))).toBe(0);
    expect(
      Math.abs(
        distanceKm(
          { latitude: 0, longitude: 0 },
          { latitude: 0, longitude: 180 },
        ) - 20015,
      ),
    ).toBeLessThan(20);
  });

  it("air labels follow the European index and the UV scale", () => {
    expect([10, 30, 50, 70, 90, 150].map(aqiLabel)).toEqual([
      "goed",
      "redelijk",
      "matig",
      "slecht",
      "zeer slecht",
      "extreem slecht",
    ]);
    expect([1, 4, 7, 9, 12].map(uvLabel)).toEqual([
      "laag",
      "matig",
      "hoog",
      "zeer hoog",
      "extreem",
    ]);
    expect(aqiLabel(null)).toBeNull();
  });

  it("firstSentence cuts a story to one short sentence", () => {
    expect(
      firstSentence("Eerste zin. Tweede zin die niet meer hoeft.", 180),
    ).toBe("Eerste zin.");
    expect(
      firstSentence(
        "Geen punt maar wel een heel lang verhaal dat doorgaat",
        20,
      ),
    ).toBe("Geen punt maar wel e…");
    expect(firstSentence("", 50)).toBe("");
  });
});

describe("WorldModule", () => {
  it("registers one read-only tool source with all eleven tools", async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, WorldModule],
    }).compile();
    const source = moduleRef.get(WorldSource);
    const defs = source.definitions();
    expect(defs.map((d) => d.name).sort()).toEqual(
      [...WORLD_TOOL_NAMES].sort(),
    );
    expect(defs).toHaveLength(11);
    for (const def of defs) {
      expect(def.risk, def.name).toBe("READ_ONLY");
      expect(def.enabled).not.toBe(false);
      for (const key of def.parameters.required ?? [])
        expect(key in def.parameters.properties, `${def.name}.${key}`).toBe(
          true,
        );
    }
    expect(
      defs.find((d) => d.name === "weather_forecast")?.parameters.required,
    ).toEqual([]);
    expect(defs.find((d) => d.name === "web_read")?.timeoutMs).toBe(20000);
    expect(moduleRef.get(WorldService)).toBeInstanceOf(WorldService);
    const out = await source.execute(
      "moon_phase",
      {},
      {
        sessionId: "t",
        signal: new AbortController().signal,
      },
    );
    expect(out.ok).toBe(true);
    await moduleRef.close();
  });
});

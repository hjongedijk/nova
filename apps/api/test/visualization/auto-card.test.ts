import { describe, expect, it } from "vitest";
import {
  INLINE_CARD_TOOLS,
  MAX_INLINE_BYTES,
  inlineCardFor,
} from "../../src/visualization/auto-card.js";
import { validateScene } from "../../src/visualization/scene.validation.js";

const now = new Date("2026-10-16T12:32:00.000Z");
const ctx = { now, timeZone: "Europe/Amsterdam", id: "inline-test0001" };
const ok = (result: unknown) => ({ ok: true, result });

const forecast = {
  location: { name: "Utrecht" },
  current: {
    temperature: 15,
    feelsLike: 13,
    humidityPercent: 70,
    windKmh: 18,
    condition: "half bewolkt",
    isDay: true,
  },
  days: [
    {
      weekday: "vrijdag",
      min: 8,
      max: 16,
      rainMm: 4,
      rainChancePercent: 80,
      condition: "regen",
      sunrise: "08:00",
      sunset: "18:30",
    },
    {
      weekday: "zaterdag",
      min: 6,
      max: 12,
      rainMm: 0,
      rainChancePercent: null,
      condition: "helder",
    },
  ],
  nextHours: [
    {
      time: "14:00",
      temperature: 15,
      rainChancePercent: 10,
      condition: "bewolkt",
    },
    {
      time: "19:00",
      temperature: 12,
      rainChancePercent: null,
      condition: "lichte regen",
    },
    {
      time: "22:00",
      temperature: 10,
      rainChancePercent: 0,
      condition: "helder",
    },
  ],
};

describe("inline cards from real tool results", () => {
  it("maps weather_forecast to a valid weather card with honest unknowns and night glyphs", () => {
    const scene = inlineCardFor("weather_forecast", ok(forecast), ctx)!;
    expect(scene.kind).toBe("weather");
    expect(validateScene(scene)).toEqual({ ok: true, errors: [] });
    expect(scene.weather!.hours.map((h) => h.glyph)).toEqual([
      "cloud",
      "rain",
      "night",
    ]);
    expect(scene.weather!.hours[1]!.rainPercent).toBeNull();
    expect(scene.weather!.days[0]!.label).toBe("vandaag");
    expect(scene.summary).toContain("Utrecht");
  });

  it("gives no card for failures, confirmations, empty data or unknown tools", () => {
    expect(
      inlineCardFor("weather_forecast", { ok: false, error: "x" }, ctx),
    ).toBeNull();
    expect(
      inlineCardFor(
        "weather_forecast",
        { ok: true, result: forecast, requiresConfirmation: true },
        ctx,
      ),
    ).toBeNull();
    expect(
      inlineCardFor("weather_forecast", ok({ days: [], nextHours: [] }), ctx),
    ).toBeNull();
    expect(inlineCardFor("weather_forecast", ok(null), ctx)).toBeNull();
    expect(
      inlineCardFor("web_search", ok({ results: [1, 2, 3] }), ctx),
    ).toBeNull();
    expect(
      inlineCardFor("create_visualization", ok({ id: "viz-1" }), ctx),
    ).toBeNull();
    expect(INLINE_CARD_TOOLS).not.toContain("web_search");
  });

  it("maps Proxmox nodes to gauges, offline nodes are unknown (never green)", () => {
    const scene = inlineCardFor(
      "proxmox_status",
      ok({
        nodes: [
          {
            node: "pve1",
            status: "online",
            cpu: { usagePercent: 95, cores: 8 },
            memory: { usedGB: 20, totalGB: 64, usagePercent: 31 },
          },
          {
            node: "pve2",
            status: "offline",
            cpu: { usagePercent: 0, cores: 4 },
            memory: { usedGB: 0, totalGB: 32, usagePercent: 0 },
          },
        ],
      }),
      ctx,
    )!;
    expect(scene.kind).toBe("gauges");
    const byId = Object.fromEntries(scene.gauges!.map((g) => [g.id, g]));
    expect(byId["cpu:pve1"]!.status).toBe("critical");
    expect(byId["mem:pve1"]!.status).toBe("ok");
    expect(byId["cpu:pve2"]).toMatchObject({ value: null, status: "unknown" });
    expect(validateScene(scene).ok).toBe(true);
  });

  it("maps guests to grouped tiles with state words and needs two guests", () => {
    const guest = (vmid: number, status: string, node = "pve1") => ({
      vmid,
      name: `vm${vmid}`,
      node,
      type: "qemu",
      status,
      cpuUsagePercent: 5,
      memoryUsed: 1,
      memoryTotal: 2,
    });
    const scene = inlineCardFor(
      "proxmox_guests",
      ok({
        guests: [
          guest(1, "running"),
          guest(2, "stopped"),
          guest(3, "weird", "pve2"),
        ],
      }),
      ctx,
    )!;
    expect(scene.kind).toBe("tiles");
    expect(scene.tiles!.map((t) => [t.state, t.status])).toEqual([
      ["Draait", "ok"],
      ["Gestopt", "off"],
      ["Onbekend", "unknown"],
    ]);
    expect(scene.tileGroups!.map((g) => g.label)).toEqual(["pve1", "pve2"]);
    expect(
      inlineCardFor(
        "proxmox_guests",
        ok({ guests: [guest(1, "running")] }),
        ctx,
      ),
    ).toBeNull();
  });

  it("caps tiles and keeps the payload under the byte cap", () => {
    const guests = Array.from({ length: 300 }, (_, i) => ({
      vmid: i + 1,
      name: `vm-${i}`,
      node: "pve1",
      type: "lxc",
      status: "running",
      cpuUsagePercent: 1,
      memoryUsed: 1,
      memoryTotal: 4,
    }));
    const scene = inlineCardFor("proxmox_guests", ok({ guests }), ctx);
    expect(scene === null || scene.tiles!.length <= 120).toBe(true);
    if (scene)
      expect(JSON.stringify(scene).length).toBeLessThan(MAX_INLINE_BYTES);
  });

  it("shows today's calendar on a time axis and the next day when today is empty", () => {
    const events = [
      {
        summary: "Tandarts",
        start: "2026-10-16T14:00:00",
        end: "2026-10-16T15:00:00",
        timeZone: "Europe/Amsterdam",
        allDay: false,
      },
      {
        summary: "Vakantie",
        start: "2026-10-16",
        end: "2026-10-17",
        timeZone: null,
        allDay: true,
      },
    ];
    const today = inlineCardFor("calendar_events", ok({ events }), ctx)!;
    expect(today.kind).toBe("timeline");
    expect(today.title).toBe("Agenda vandaag");
    expect(today.timeline!.items).toHaveLength(2);
    expect(
      today.timeline!.items.find((i) => i.label === "Tandarts")!.start,
    ).toBe("2026-10-16T12:00:00.000Z");
    expect(validateScene(today).ok).toBe(true);
    const later = inlineCardFor(
      "calendar_events",
      ok({
        events: [
          {
            summary: "Later",
            start: "2026-10-18T09:00:00+02:00",
            end: "2026-10-18T10:00:00+02:00",
            timeZone: null,
            allDay: false,
          },
        ],
      }),
      ctx,
    )!;
    expect(later.notes[0]).toContain("eerstvolgende dag");
    expect(
      inlineCardFor("calendar_events", ok({ events: [] }), ctx),
    ).toBeNull();
  });

  it("shows timers as countdown bars", () => {
    const scene = inlineCardFor(
      "timer_list",
      ok({
        count: 1,
        timers: [
          {
            id: "t1",
            label: "Pasta",
            fireAt: "2026-10-16T12:41:00.000Z",
            remainingSeconds: 540,
          },
        ],
      }),
      ctx,
    )!;
    expect(scene.timeline!.items[0]).toMatchObject({
      kind: "timer",
      label: "Pasta",
    });
    expect(scene.summary).toContain("9 min");
  });

  it("maps Home Assistant entities without people, trackers or attributes beyond the unit", () => {
    const entity = (
      entity_id: string,
      state: string,
      extra: Record<string, unknown> = {},
    ) => ({
      entity_id,
      domain: entity_id.split(".")[0],
      state,
      friendly_name: entity_id,
      area: "Woonkamer",
      attributes: { ...extra, latitude: 52.1, access_token: "secret" },
    });
    const scene = inlineCardFor(
      "ha_search_entities",
      ok([
        entity("light.a", "on"),
        entity("sensor.b", "21.5", { unit_of_measurement: "°C" }),
        entity("person.jan", "home"),
        entity("device_tracker.phone", "home"),
        entity("sensor.c", "unavailable"),
      ]),
      ctx,
    )!;
    const ids = scene.tiles!.map((t) => t.id);
    expect(ids).toEqual(["light.a", "sensor.b", "sensor.c"]);
    expect(scene.tiles!.map((t) => t.state)).toEqual([
      "Aan",
      "21,5 °C",
      "Niet beschikbaar",
    ]);
    expect(JSON.stringify(scene)).not.toMatch(/secret|latitude|52\.1/);
  });

  it("maps network checks to tiles", () => {
    const scene = inlineCardFor(
      "network_check",
      ok({
        results: [
          { name: "API", ok: true, ms: 12, detail: "x" },
          { name: "MQTT", ok: false, ms: 0, detail: "host.internal refused" },
        ],
      }),
      ctx,
    )!;
    expect(scene.tiles!.map((t) => t.state)).toEqual([
      "Bereikbaar",
      "Niet bereikbaar",
    ]);
    expect(JSON.stringify(scene)).not.toContain("host.internal");
  });
});

import { afterEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { WorldService } from "../../src/integrations/world/world.service.js";
import { WorldSource } from "../../src/integrations/world/world.source.js";
import { routeEstimate } from "../../src/integrations/world/route.js";
import type { WorldHttp } from "../../src/integrations/world/world.types.js";
import type { CalDavService } from "../../src/planning/caldav.service.js";

const from = {
  name: "Utrecht",
  region: null,
  country: "Nederland",
  latitude: 52.09,
  longitude: 5.12,
};
const to = {
  name: "Amersfoort",
  region: null,
  country: "Nederland",
  latitude: 52.16,
  longitude: 5.39,
};

describe("optional road route estimates", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("sends coordinates and a server-side key only to the fixed route host", async () => {
    const request = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            routes: [{ summary: { distance: 23800, duration: 1680 } }],
          }),
          { status: 200 },
        ),
    );
    const result = await routeEstimate(
      "private-key",
      from,
      to,
      "driving-car",
      undefined,
      request as typeof fetch,
    );
    expect(result).toMatchObject({
      distanceKm: 23.8,
      durationMinutes: 28,
      liveTraffic: false,
    });
    const [url, init] = request.mock.calls[0] as unknown as [
      string,
      RequestInit,
    ];
    expect(url).toBe(
      "https://api.heigit.org/openrouteservice/v2/directions/driving-car",
    );
    expect(init.headers).toMatchObject({ authorization: "private-key" });
    expect(JSON.parse(String(init.body))).toMatchObject({
      coordinates: [
        [5.12, 52.09],
        [5.39, 52.16],
      ],
      geometry: false,
    });
    expect(String(init.body)).not.toContain("private-key");
  });

  it("rejects malformed or oversized route replies without exposing upstream text", async () => {
    const request = vi.fn(
      async () => new Response("upstream secret", { status: 500 }),
    );
    await expect(
      routeEstimate(
        "key",
        from,
        to,
        "driving-car",
        undefined,
        request as typeof fetch,
      ),
    ).rejects.toThrow("Routebron tijdelijk niet beschikbaar.");
    request.mockResolvedValueOnce(
      new Response("x".repeat(70_000), { status: 200 }),
    );
    await expect(
      routeEstimate(
        "key",
        from,
        to,
        "driving-car",
        undefined,
        request as typeof fetch,
      ),
    ).rejects.toThrow("Routeantwoord te groot.");
  });

  it("registers the tool only with a configured key and resolves named cities", async () => {
    const http = {
      getJson: vi.fn(async (url: string) => ({
        results: [url.includes("Utrecht") ? from : to],
      })),
    } as unknown as WorldHttp;
    const disabled = new WorldSource(
      new WorldService({ openRouteServiceKey: "" } as NovaConfig, http),
    );
    expect(
      disabled.definitions().some((item) => item.name === "route_estimate"),
    ).toBe(false);
    const world = new WorldService(
      { openRouteServiceKey: "private-key" } as NovaConfig,
      http,
    );
    expect(
      new WorldSource(world)
        .definitions()
        .some((item) => item.name === "route_estimate"),
    ).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              routes: [{ summary: { distance: 23800, duration: 1680 } }],
            }),
            { status: 200 },
          ),
      ),
    );
    expect(
      await world.execute("route_estimate", {
        origin: "Utrecht",
        destination: "Amersfoort",
      }),
    ).toMatchObject({
      ok: true,
      result: { durationMinutes: 28, liveTraffic: false },
    });
  });

  it("advises a departure time for one exact calendar appointment and named city", async () => {
    const start = new Date(Date.now() + 3 * 60 * 60_000);
    const calendar = {
      configured: true,
      upcoming: vi.fn(async () => [
        {
          summary: "Tandarts",
          start: start.toISOString(),
          end: null,
          timeZone: null,
          allDay: false,
        },
      ]),
    } as unknown as CalDavService;
    const http = {
      getJson: vi.fn(async () => ({ results: [to] })),
    } as unknown as WorldHttp;
    const world = new WorldService(
      {
        openRouteServiceKey: "private-key",
        homeLocation: from,
        timezone: "Europe/Amsterdam",
      } as unknown as NovaConfig,
      http,
    );
    const source = new WorldSource(world, calendar);
    expect(
      source.definitions().some((item) => item.name === "calendar_departure"),
    ).toBe(true);
    vi.stubGlobal(
      "fetch",
      vi.fn(
        async () =>
          new Response(
            JSON.stringify({
              routes: [{ summary: { distance: 23800, duration: 1680 } }],
            }),
            { status: 200 },
          ),
      ),
    );
    const result = await world.execute(
      "calendar_departure",
      { summary: "Tandarts", destination: "Amersfoort" },
      undefined,
      calendar,
    );
    expect(result).toMatchObject({
      ok: true,
      result: {
        appointmentAt: start.toISOString(),
        bufferMinutes: 15,
        route: { durationMinutes: 28, liveTraffic: false },
      },
    });
    expect((result.result as { leaveAt: string }).leaveAt).toBe(
      new Date(start.getTime() - 43 * 60_000).toISOString(),
    );
    expect(http.getJson).toHaveBeenCalledTimes(1);
    (calendar.upcoming as ReturnType<typeof vi.fn>).mockResolvedValueOnce([
      {
        summary: "Tandarts",
        start: start.toISOString(),
        end: null,
        timeZone: null,
        allDay: false,
      },
      {
        summary: "Tandarts",
        start: start.toISOString(),
        end: null,
        timeZone: null,
        allDay: false,
      },
    ]);
    expect(
      await world.execute(
        "calendar_departure",
        { summary: "Tandarts", destination: "Amersfoort" },
        undefined,
        calendar,
      ),
    ).toEqual({ ok: false, error: "Afspraak niet eenduidig gevonden." });
  });
});

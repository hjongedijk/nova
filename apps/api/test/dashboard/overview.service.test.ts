import { describe, expect, it, vi } from "vitest";
import { DashboardController } from "../../src/dashboard/dashboard.controller.js";
import { OverviewService } from "../../src/dashboard/overview.service.js";

function fixture(options: {
  required: boolean;
  configured: boolean;
  fail?: boolean;
}) {
  const upcoming = vi.fn(async () => {
    if (options.fail) throw new Error("private calendar diagnostic");
    return [
      {
        summary: "Tandarts",
        start: "2026-10-13T09:00:00",
        end: "2026-10-13T09:30:00",
        allDay: false,
        timeZone: "Europe/Amsterdam",
        privateData: "must not escape",
      },
    ];
  });
  const service = new OverviewService(
    { configured: false } as never,
    { timers: () => [], lists: () => ({}) } as never,
    { alerts: () => [] } as never,
    {
      configured: false,
      sync: async () => [],
      visibleEntities: () => [],
    } as never,
    {
      homeForecast: async () => null,
      ready: async () => undefined,
      home: () => null,
      execute: async () => ({ ok: false }),
      airQuality: async () => null,
      markets: async () => null,
      iss: async () => null,
      moon: () => null,
    } as never,
    { configured: options.configured, upcoming } as never,
    { required: options.required } as never,
  );
  return { service, upcoming };
}

describe("overview calendar privacy", () => {
  it("does not expose unexpected overview diagnostics through the API", async () => {
    const controller = new DashboardController(
      null as never,
      null as never,
      {
        overview: async () => {
          throw new Error("private-host?token=secret-value");
        },
      } as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
      null as never,
    );
    const error = (await controller
      .overviewData()
      .catch((caught: unknown) => caught)) as Error & {
      getResponse(): unknown;
    };
    expect(JSON.stringify(error.getResponse())).not.toContain("secret-value");
    expect(JSON.stringify(error.getResponse())).toContain(
      "Overzicht is tijdelijk niet beschikbaar.",
    );
  });
  it("does not request or expose appointments without app access enabled", async () => {
    const { service, upcoming } = fixture({
      required: false,
      configured: true,
    });

    const overview = await service.overview();

    expect(upcoming).not.toHaveBeenCalled();
    expect(overview.calendarStatus).toBe("protected");
    expect(overview.nextAppointment).toBeNull();
  });

  it("returns only the next appointment's display fields behind app access", async () => {
    const { service, upcoming } = fixture({
      required: true,
      configured: true,
    });

    const overview = await service.overview();

    expect(upcoming).toHaveBeenCalledOnce();
    expect(overview.calendarStatus).toBe("ready");
    expect(overview.nextAppointment).toEqual({
      summary: "Tandarts",
      start: "2026-10-13T09:00:00",
      end: "2026-10-13T09:30:00",
      allDay: false,
      timeZone: "Europe/Amsterdam",
    });
  });

  it("does not describe a failed calendar request as an empty agenda", async () => {
    const { service } = fixture({
      required: true,
      configured: true,
      fail: true,
    });

    const overview = await service.overview();

    expect(overview.calendarStatus).toBe("error");
    expect(overview.nextAppointment).toBeNull();
    expect(JSON.stringify(overview)).not.toContain(
      "private calendar diagnostic",
    );
  });
});

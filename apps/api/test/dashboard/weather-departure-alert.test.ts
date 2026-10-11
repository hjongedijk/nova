import { describe, expect, it, vi } from "vitest";
import type { WeatherHour, WeatherForecast } from "@nova/contracts";
import type { WorldService } from "../../src/integrations/world/world.service.js";
import type { AlertsFeed } from "../../src/dashboard/alerts-feed.service.js";
import type { SpeechPresenceService } from "../../src/dashboard/speech-presence.service.js";
import {
  departureWeather,
  WeatherDepartureAlertService,
} from "../../src/dashboard/weather-departure-alert.service.js";

const hour = (
  time: string,
  condition: string,
  rainChancePercent: number | null,
): WeatherHour => ({
  time,
  temperature: 12,
  condition,
  rainChancePercent,
});

describe("weather departure alerts", () => {
  it("uses only the next three hours and requires likely rain unless severe", () => {
    expect(
      departureWeather([
        hour("10:00", "regen", 65),
        hour("11:00", "motregen", 64),
        hour("12:00", "onweer", null),
        hour("13:00", "zware buien", 100),
      ]),
    ).toEqual([hour("10:00", "regen", 65), hour("12:00", "onweer", null)]);
  });

  it("alerts only on a confirmed home-to-away transition", async () => {
    let transition:
      ((from: "home" | "away", to: "home" | "away") => void) | undefined;
    const presence = {
      onTransition: vi.fn((callback) => {
        transition = callback;
        return () => {
          transition = undefined;
        };
      }),
    } as unknown as SpeechPresenceService;
    const forecast = {
      nextHours: [hour("14:00", "regen", 80)],
    } as WeatherForecast;
    const world = {
      homeForecast: vi.fn(async () => forecast),
    } as unknown as WorldService;
    const alerts = { record: vi.fn() } as unknown as AlertsFeed;
    const service = new WeatherDepartureAlertService(presence, world, alerts);
    service.onModuleInit();

    transition?.("away", "home");
    transition?.("home", "away");
    await vi.waitFor(() => expect(alerts.record).toHaveBeenCalledTimes(1));
    expect(world.homeForecast).toHaveBeenCalledTimes(1);
    expect(alerts.record).toHaveBeenCalledWith(
      expect.objectContaining({
        topic: "jarvis/alerts",
        payload: expect.objectContaining({
          title: "Regen op komst rond 14:00",
        }),
      }),
    );

    service.onModuleDestroy();
    expect(transition).toBeUndefined();
  });

  it("stays quiet when the home forecast is unavailable or benign", async () => {
    const onTransition = vi.fn();
    const presence = {
      onTransition: (callback: typeof onTransition) => {
        onTransition.mockImplementation(callback);
        return () => undefined;
      },
    } as unknown as SpeechPresenceService;
    const world = {
      homeForecast: vi.fn(async () => ({
        nextHours: [hour("14:00", "bewolkt", 10)],
      })),
    } as unknown as WorldService;
    const alerts = { record: vi.fn() } as unknown as AlertsFeed;
    const service = new WeatherDepartureAlertService(presence, world, alerts);
    service.onModuleInit();
    onTransition("home", "away");
    await vi.waitFor(() => expect(world.homeForecast).toHaveBeenCalled());
    expect(alerts.record).not.toHaveBeenCalled();
  });
});

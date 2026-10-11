import {
  Injectable,
  type OnModuleDestroy,
  type OnModuleInit,
} from "@nestjs/common";
import type { WeatherHour } from "@nova/contracts";
import { WorldService } from "../integrations/world/world.service.js";
import { SpeechPresenceService } from "./speech-presence.service.js";
import { AlertsFeed } from "./alerts-feed.service.js";

const HOURS_AHEAD = 3;
const RAIN_THRESHOLD = 65;
const SEVERE = /onweer|hagel|ijzel|zware regen|zware buien|zware sneeuw/i;
const WET = /regen|motregen|bui|ijzel|sneeuw/i;

export function departureWeather(hours: WeatherHour[]): WeatherHour[] {
  return hours
    .slice(0, HOURS_AHEAD)
    .filter(
      (hour) =>
        SEVERE.test(hour.condition) ||
        (WET.test(hour.condition) &&
          hour.rainChancePercent !== null &&
          hour.rainChancePercent >= RAIN_THRESHOLD),
    );
}

/** Checks a short local forecast after a confirmed home-to-away transition. */
@Injectable()
export class WeatherDepartureAlertService
  implements OnModuleInit, OnModuleDestroy
{
  private unsubscribe?: () => void;

  constructor(
    private readonly presence: SpeechPresenceService,
    private readonly world: WorldService,
    private readonly alerts: AlertsFeed,
  ) {}

  onModuleInit(): void {
    this.unsubscribe = this.presence.onTransition((from, to) => {
      if (from === "home" && to === "away") void this.checkForecast();
    });
  }

  onModuleDestroy(): void {
    this.unsubscribe?.();
  }

  private async checkForecast(): Promise<void> {
    try {
      const forecast = await this.world.homeForecast();
      if (!forecast) return;
      const warnings = departureWeather(forecast.nextHours);
      if (!warnings.length) return;
      const first = warnings[0]!;
      const headline = warnings.some((hour) =>
        /onweer|hagel|ijzel/i.test(hour.condition),
      )
        ? "Onstuimig weer op komst"
        : "Regen op komst";
      const detail = warnings
        .map(
          (hour) =>
            `${hour.time}: ${hour.condition}${hour.rainChancePercent === null ? "" : ` (${hour.rainChancePercent}% kans)`}`,
        )
        .join("; ")
        .slice(0, 240);
      this.alerts.record({
        topic: "jarvis/alerts",
        payload: {
          title: `${headline} rond ${first.time}`,
          detail,
          severity: warnings.some((hour) => SEVERE.test(hour.condition))
            ? "warning"
            : "info",
          key: "weather-departure",
          at: new Date().toISOString(),
        },
      });
    } catch {
      // Forecast availability must never affect presence handling.
    }
  }
}

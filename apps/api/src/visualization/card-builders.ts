import type {
  VizGauge,
  VizGlyph,
  VizStatus,
  VizTile,
  VizTileGroup,
  VizWeather,
} from "@nova/contracts";
import type { ProviderScene } from "./visualization.types.js";

/*
 * Pure builders for the card scenes (weather, gauges, tiles, timeline). They only reshape data a
 * tool or service really returned: a missing value stays null/"onbekend" and is never replaced by
 * a guess. Used by the inline cards of the chat and by the structured provider types.
 */

/** Strip control characters and cut to a length: scene text is data for the screen, never markup. */
export function clean(value: unknown, max = 80): string {
  const text = String(value ?? "")
    .split("")
    .map((char) =>
      char.charCodeAt(0) < 32 || char.charCodeAt(0) === 127 ? " " : char,
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim();
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

const NL = new Intl.NumberFormat("nl-NL", { maximumFractionDigits: 1 });
export const nl = (value: number): string => NL.format(value);
export const finiteOrNull = (value: unknown): number | null =>
  typeof value === "number" && Number.isFinite(value) ? value : null;
const clamp = (value: number, min: number, max: number) =>
  Math.min(max, Math.max(min, value));

export function gaugeStatus(
  value: number | null,
  limits: { warnAt?: number; critAt?: number; worse?: "high" | "low" },
): VizStatus {
  if (value === null) return "unknown";
  const { warnAt, critAt, worse = "high" } = limits;
  if (worse === "high") {
    if (critAt !== undefined && value >= critAt) return "critical";
    if (warnAt !== undefined && value >= warnAt) return "warning";
    return "ok";
  }
  if (critAt !== undefined && value <= critAt) return "critical";
  if (warnAt !== undefined && value <= warnAt) return "warning";
  return "ok";
}

/** A 0..100 percentage gauge (CPU, memory, disk, battery, humidity). */
export function percentGauge(input: {
  id: string;
  label: string;
  value: number | null;
  detail?: string;
  warnAt?: number;
  critAt?: number;
  worse?: "high" | "low";
}): VizGauge {
  const value =
    input.value === null
      ? null
      : clamp(Math.round(input.value * 10) / 10, 0, 100);
  return {
    id: input.id,
    label: clean(input.label, 60),
    value,
    unit: "%",
    min: 0,
    max: 100,
    ...(input.warnAt !== undefined ? { warnAt: input.warnAt } : {}),
    ...(input.critAt !== undefined ? { critAt: input.critAt } : {}),
    ...(input.worse ? { worse: input.worse } : {}),
    status: gaugeStatus(value, input),
    ...(input.detail ? { detail: clean(input.detail, 120) } : {}),
  };
}

/** Load gauge: 75% is "let op", 90% is "probleem". */
export const loadGauge = (input: {
  id: string;
  label: string;
  value: number | null;
  detail?: string;
}): VizGauge => percentGauge({ ...input, warnAt: 75, critAt: 90 });

export function gaugesScene(
  title: string,
  gauges: VizGauge[],
  extra: Partial<ProviderScene> = {},
): ProviderScene {
  const unknown = gauges.filter((gauge) => gauge.value === null).length;
  const worst = gauges.filter(
    (gauge) => gauge.status === "critical" || gauge.status === "warning",
  );
  return {
    title,
    gauges,
    summary: clean(
      `${title}: ${gauges
        .map(
          (gauge) =>
            `${gauge.label} ${gauge.value === null ? "onbekend" : `${nl(gauge.value)}${gauge.unit === "%" ? "%" : ` ${gauge.unit}`}`}`,
        )
        .join(
          ", ",
        )}.${worst.length ? ` Let op: ${worst.map((gauge) => gauge.label).join(", ")}.` : ""}`,
      400,
    ),
    notes: unknown
      ? ["Een onbekende waarde is niet gemeten; ze is nooit groen."]
      : [],
    ...extra,
  };
}

export function tilesScene(
  title: string,
  tiles: VizTile[],
  groups: VizTileGroup[] | undefined,
  extra: Partial<ProviderScene> = {},
): ProviderScene {
  const count = (status: VizStatus) =>
    tiles.filter((tile) => tile.status === status).length;
  const parts = [
    count("ok") + count("active")
      ? `${count("ok") + count("active")} in orde of actief`
      : "",
    count("warning") ? `${count("warning")} let op` : "",
    count("critical") ? `${count("critical")} probleem` : "",
    count("off") ? `${count("off")} uit` : "",
    count("unknown") ? `${count("unknown")} onbekend` : "",
  ].filter(Boolean);
  return {
    title,
    tiles,
    ...(groups?.length ? { tileGroups: groups } : {}),
    summary: clean(
      `${title}: ${tiles.length} onderdelen, ${parts.join(", ")}.`,
      400,
    ),
    notes: [],
    ...extra,
  };
}

const WORDS: [RegExp, VizGlyph][] = [
  [/onweer/, "storm"],
  [/sneeuw|korrelsneeuw/, "snow"],
  [/motregen|ijzel/, "drizzle"],
  [/regen|buien/, "rain"],
  [/mist/, "fog"],
  [/half bewolkt|overwegend helder/, "partly"],
  [/bewolkt/, "cloud"],
  [/helder/, "clear"],
];

/** Glyph for a Dutch weather description ("lichte regen"); night variants for clear/partly. */
export function glyphFor(condition: string, night = false): VizGlyph {
  const text = condition.toLocaleLowerCase("nl-NL");
  for (const [pattern, glyph] of WORDS)
    if (pattern.test(text)) {
      if (night && glyph === "clear") return "night";
      if (night && glyph === "partly") return "night-cloud";
      return glyph;
    }
  return "unknown";
}

const minutes = (hhmm: string | undefined): number | null => {
  const match = /^(\d{2}):(\d{2})$/.exec(hhmm ?? "");
  return match ? Number(match[1]) * 60 + Number(match[2]) : null;
};

interface ForecastShape {
  location?: { name?: string };
  current?: {
    temperature?: number;
    feelsLike?: number;
    humidityPercent?: number;
    windKmh?: number;
    condition?: string;
    isDay?: boolean;
  };
  days?: {
    weekday?: string;
    min?: number;
    max?: number;
    rainMm?: number;
    rainChancePercent?: number | null;
    condition?: string;
    sunrise?: string;
    sunset?: string;
  }[];
  nextHours?: {
    time?: string;
    temperature?: number;
    rainChancePercent?: number | null;
    condition?: string;
  }[];
}

/** WeatherForecast (tool result of weather_forecast) to a weather card, or null without data. */
export function weatherScene(forecast: ForecastShape): ProviderScene | null {
  const place = clean(forecast.location?.name || "Thuis", 60);
  const sunrise = minutes(forecast.days?.[0]?.sunrise);
  const sunset = minutes(forecast.days?.[0]?.sunset);
  const isNight = (time: string | undefined): boolean => {
    const at = minutes(time);
    return at !== null && sunrise !== null && sunset !== null
      ? at < sunrise || at >= sunset
      : false;
  };
  const hours: VizWeather["hours"] = (forecast.nextHours ?? [])
    .filter((hour) => /^\d{2}:\d{2}$/.test(hour.time ?? ""))
    .slice(0, 24)
    .map((hour) => {
      const condition = clean(hour.condition || "onbekend", 40);
      return {
        label: hour.time!,
        temperature: finiteOrNull(hour.temperature),
        rainPercent:
          finiteOrNull(hour.rainChancePercent) === null
            ? null
            : clamp(Math.round(hour.rainChancePercent as number), 0, 100),
        condition,
        glyph: glyphFor(condition, isNight(hour.time)),
      };
    });
  const days: VizWeather["days"] = (forecast.days ?? [])
    .slice(0, 7)
    .map((day, index) => {
      const condition = clean(day.condition || "onbekend", 40);
      return {
        label:
          index === 0
            ? "vandaag"
            : index === 1
              ? "morgen"
              : clean(day.weekday || "", 20) || `dag ${index + 1}`,
        min: finiteOrNull(day.min),
        max: finiteOrNull(day.max),
        rainMm: finiteOrNull(day.rainMm),
        rainPercent:
          finiteOrNull(day.rainChancePercent) === null
            ? null
            : clamp(Math.round(day.rainChancePercent as number), 0, 100),
        condition,
        glyph: glyphFor(condition),
      };
    });
  const known =
    hours.some((hour) => hour.temperature !== null) ||
    days.some((day) => day.max !== null || day.min !== null);
  if (!known) return null;
  const current = forecast.current;
  const nowTemperature = finiteOrNull(current?.temperature);
  const nowCondition = clean(current?.condition || "onbekend", 40);
  const weather: VizWeather = {
    place,
    ...(current && nowTemperature !== null
      ? {
          now: {
            temperature: nowTemperature,
            feelsLike: finiteOrNull(current.feelsLike),
            condition: nowCondition,
            glyph: glyphFor(nowCondition, current.isDay === false),
            windKmh: finiteOrNull(current.windKmh),
            humidityPercent: finiteOrNull(current.humidityPercent),
          },
        }
      : {}),
    hours,
    days,
  };
  const today = days[0];
  const summary = [
    `Weer in ${place}:`,
    weather.now
      ? `nu ${Math.round(weather.now.temperature!)}° en ${weather.now.condition}.`
      : "",
    today && today.min !== null && today.max !== null
      ? `Vandaag ${Math.round(today.min)}° tot ${Math.round(today.max)}°${today.rainPercent !== null && today.rainPercent >= 30 ? `, ${today.rainPercent}% kans op regen` : ""}.`
      : "",
    days.length > 1 ? `${days.length} dagen vooruit.` : "",
  ]
    .filter(Boolean)
    .join(" ");
  return {
    title: `Weer in ${place}`,
    weather,
    summary: clean(summary, 400),
    notes: ["Bron: Open-Meteo."],
  };
}

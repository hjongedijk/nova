import type { WeatherForecast, WorldPlace } from "@nova/contracts";
import type { WorldHttp } from "./world.types.js";

const WMO: Record<number, string> = {
  0: "helder",
  1: "overwegend helder",
  2: "half bewolkt",
  3: "bewolkt",
  45: "mist",
  48: "mist met rijp",
  51: "lichte motregen",
  53: "motregen",
  55: "dichte motregen",
  56: "lichte ijzel",
  57: "ijzel",
  61: "lichte regen",
  63: "regen",
  65: "zware regen",
  66: "lichte ijzelregen",
  67: "ijzelregen",
  71: "lichte sneeuw",
  73: "sneeuw",
  75: "zware sneeuw",
  77: "korrelsneeuw",
  80: "lichte buien",
  81: "buien",
  82: "zware buien",
  85: "sneeuwbuien",
  86: "zware sneeuwbuien",
  95: "onweer",
  96: "onweer met hagel",
  99: "zwaar onweer met hagel",
};
export const describeWeather = (code: number | undefined): string =>
  (code === undefined ? undefined : WMO[code]) ?? "onbekend";

interface ForecastResponse {
  timezone?: string;
  current?: {
    time?: string;
    temperature_2m: number;
    apparent_temperature: number;
    relative_humidity_2m: number;
    precipitation: number;
    weather_code: number;
    wind_speed_10m: number;
    wind_gusts_10m: number;
    is_day: number;
  };
  daily?: {
    time?: string[];
    weather_code: number[];
    temperature_2m_max: number[];
    temperature_2m_min: number[];
    precipitation_sum: number[];
    precipitation_probability_max?: (number | null)[];
    sunrise?: string[];
    sunset?: string[];
  };
  hourly?: {
    time?: string[];
    temperature_2m: number[];
    precipitation_probability?: (number | null)[];
    weather_code: number[];
  };
}

const weekday = (date: string) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString("nl-NL", {
    weekday: "long",
    timeZone: "UTC",
  });
const degrees = (value: number) => `${Math.round(value)}°`;

export async function forecast(
  http: WorldHttp,
  place: WorldPlace | { latitude: number; longitude: number; name: string },
  days = 2,
  signal?: AbortSignal,
): Promise<WeatherForecast> {
  const url =
    `https://api.open-meteo.com/v1/forecast?latitude=${place.latitude}&longitude=${place.longitude}` +
    `&current=temperature_2m,apparent_temperature,relative_humidity_2m,precipitation,weather_code,wind_speed_10m,wind_gusts_10m,is_day` +
    `&daily=weather_code,temperature_2m_max,temperature_2m_min,precipitation_sum,precipitation_probability_max,sunrise,sunset` +
    `&hourly=temperature_2m,precipitation_probability,weather_code` +
    `&timezone=auto&forecast_days=${days}&wind_speed_unit=kmh`;
  const d = await http.getJson<ForecastResponse>(url, signal);
  // Missing "current" would make every number below undefined: fail like the prototype did.
  const c = d.current ?? ({} as NonNullable<ForecastResponse["current"]>);
  const daily = d.daily;
  const dayList = (daily?.time ?? []).map((date, i) => ({
    date,
    weekday: weekday(date),
    min: daily?.temperature_2m_min[i] as number,
    max: daily?.temperature_2m_max[i] as number,
    rainChancePercent: daily?.precipitation_probability_max?.[i] ?? null,
    rainMm: daily?.precipitation_sum[i] as number,
    condition: describeWeather(daily?.weather_code[i]),
    sunrise: daily?.sunrise?.[i]?.slice(11, 16),
    sunset: daily?.sunset?.[i]?.slice(11, 16),
  }));
  const hourly = d.hourly;
  const times = hourly?.time ?? [];
  const now = c.time ?? "";
  const start = Math.max(
    0,
    times.findIndex((time) => time >= now.slice(0, 13)),
  );
  const nextHours = times.slice(start, start + 12).map((time, k) => ({
    time: time.slice(11, 16),
    temperature: hourly?.temperature_2m[start + k] as number,
    rainChancePercent: hourly?.precipitation_probability?.[start + k] ?? null,
    condition: describeWeather(hourly?.weather_code[start + k]),
  }));
  const summary = {
    nu: `${degrees(c.temperature_2m)} en ${describeWeather(c.weather_code)}${
      c.wind_speed_10m >= 25
        ? `, het waait stevig (${Math.round(c.wind_speed_10m)} km/u)`
        : ""
    }`,
    dagen: dayList.map((day, i) => {
      const name = i === 0 ? "vandaag" : i === 1 ? "morgen" : day.weekday;
      const rain =
        day.rainChancePercent !== null && day.rainChancePercent >= 30
          ? `, ${day.rainChancePercent}% kans op regen`
          : "";
      return `${name}: ${degrees(day.min)} tot ${degrees(day.max)}, ${day.condition}${rain}`;
    }),
  };
  return {
    location: {
      region: null,
      country: null,
      ...place,
      timezone: d.timezone,
    },
    summary,
    current: {
      temperature: c.temperature_2m,
      feelsLike: c.apparent_temperature,
      humidityPercent: c.relative_humidity_2m,
      windKmh: c.wind_speed_10m,
      gustsKmh: c.wind_gusts_10m,
      rainMm: c.precipitation,
      condition: describeWeather(c.weather_code),
      isDay: c.is_day === 1,
    },
    days: dayList,
    nextHours,
    source: "Open-Meteo",
    hint: "Voor nu, buiten of op dit moment: gebruik summary.nu. Voor vandaag of morgen: summary.dagen. Zeg het gesproken en afgerond en noem regen of wind alleen als dat ertoe doet.",
  };
}

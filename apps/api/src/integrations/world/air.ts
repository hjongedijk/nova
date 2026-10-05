import type { AirQuality, PollenReading } from "@nova/contracts";
import type { WorldHttp } from "./world.types.js";

type Level = number | null | undefined;

export const aqiLabel = (v: Level): string | null =>
  v == null
    ? null
    : v <= 20
      ? "goed"
      : v <= 40
        ? "redelijk"
        : v <= 60
          ? "matig"
          : v <= 80
            ? "slecht"
            : v <= 100
              ? "zeer slecht"
              : "extreem slecht";

export const uvLabel = (v: Level): string | null =>
  v == null
    ? null
    : v < 3
      ? "laag"
      : v < 6
        ? "matig"
        : v < 8
          ? "hoog"
          : v < 11
            ? "zeer hoog"
            : "extreem";

export const pollenLabel = (v: Level): string | null =>
  v == null
    ? null
    : v < 1
      ? "geen"
      : v < 20
        ? "laag"
        : v < 80
          ? "matig"
          : "hoog";

interface AirResponse {
  current?: {
    european_aqi?: number;
    pm10?: number;
    pm2_5?: number;
    uv_index?: number;
    alder_pollen?: number | null;
    birch_pollen?: number | null;
    grass_pollen?: number | null;
  };
}

export async function airQuality(
  http: WorldHttp,
  place: { latitude: number; longitude: number; name: string },
  signal?: AbortSignal,
): Promise<AirQuality> {
  const d = await http.getJson<AirResponse>(
    `https://air-quality-api.open-meteo.com/v1/air-quality?latitude=${place.latitude}&longitude=${place.longitude}` +
      `&current=european_aqi,pm10,pm2_5,uv_index,alder_pollen,birch_pollen,grass_pollen&timezone=auto`,
    signal,
  );
  const c = d.current ?? {};
  const readings: [string, number | null | undefined][] = [
    ["els", c.alder_pollen],
    ["berk", c.birch_pollen],
    ["gras", c.grass_pollen],
  ];
  const pollen: PollenReading[] = [];
  for (const [name, value] of readings)
    if (value != null)
      pollen.push({
        name,
        perM3: Math.round(value),
        label: pollenLabel(value),
      });
  const worst = pollen.reduce<PollenReading | null>(
    (top, item) => (!top || item.perM3 > top.perM3 ? item : top),
    null,
  );
  const aqi = {
    value: c.european_aqi ?? null,
    label: aqiLabel(c.european_aqi),
  };
  const uv = { value: c.uv_index ?? null, label: uvLabel(c.uv_index) };
  return {
    location: place.name,
    aqi,
    pm25: c.pm2_5 ?? null,
    pm10: c.pm10 ?? null,
    uv,
    pollen: { highest: worst, all: pollen },
    summary: [
      aqi.label && `luchtkwaliteit ${aqi.label}`,
      uv.label && `UV ${uv.label}`,
      worst && worst.perM3 >= 1 && `pollen: ${worst.name} ${worst.label}`,
    ]
      .filter(Boolean)
      .join(", "),
    source: "Open-Meteo",
    hint: "Zeg het in een of twee gesproken zinnen. Noem pollen alleen als ze er zijn.",
  };
}

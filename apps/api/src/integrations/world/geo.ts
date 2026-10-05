import type { WorldPlace } from "@nova/contracts";
import type { WorldHttp } from "./world.types.js";

interface Coordinates {
  latitude: number;
  longitude: number;
}

/** Great-circle distance in kilometres. */
export function distanceKm(a: Coordinates, b: Coordinates): number {
  const rad = (d: number) => (d * Math.PI) / 180;
  const h =
    Math.sin(rad(b.latitude - a.latitude) / 2) ** 2 +
    Math.cos(rad(a.latitude)) *
      Math.cos(rad(b.latitude)) *
      Math.sin(rad(b.longitude - a.longitude) / 2) ** 2;
  return 6371 * 2 * Math.asin(Math.sqrt(h));
}

interface GeocodeHit {
  name: string;
  admin1?: string;
  country?: string;
  country_code?: string;
  latitude: number;
  longitude: number;
}

/** "Parijs" or "Paris, Frankrijk": the part after the comma picks between places of one name. */
export async function geocode(
  http: WorldHttp,
  place: string,
  signal?: AbortSignal,
): Promise<WorldPlace> {
  const [name = "", hint] = place.split(",").map((part) => part.trim());
  const data = await http.getJson<{ results?: GeocodeHit[] }>(
    `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=8&language=nl&format=json`,
    signal,
  );
  const results = data?.results ?? [];
  const wanted = hint?.toLowerCase();
  const match =
    (wanted &&
      results.find((item) =>
        [item.country, item.admin1, item.country_code].some((field) =>
          field?.toLowerCase().includes(wanted),
        ),
      )) ||
    results[0];
  if (!match) throw new Error(`Plaats niet gevonden: ${place}`);
  return {
    name: match.name,
    region: match.admin1 ?? null,
    country: match.country ?? null,
    latitude: match.latitude,
    longitude: match.longitude,
  };
}

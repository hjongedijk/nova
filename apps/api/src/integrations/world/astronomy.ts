import type { IssPosition, MoonPhase } from "@nova/contracts";
import { distanceKm } from "./geo.js";
import type { HomeLocation } from "./home.js";
import type { WorldHttp } from "./world.types.js";

const SYNODIC_DAYS = 29.530588853;
const NEW_MOON_REFERENCE = Date.UTC(2000, 0, 6, 18, 14);

export function moonPhase(date = new Date()): MoonPhase {
  const days = (date.getTime() - NEW_MOON_REFERENCE) / 86400000;
  const age = ((days % SYNODIC_DAYS) + SYNODIC_DAYS) % SYNODIC_DAYS;
  const fraction = age / SYNODIC_DAYS;
  const name =
    fraction < 0.03 || fraction >= 0.97
      ? "nieuwe maan"
      : fraction < 0.22
        ? "wassende sikkel"
        : fraction < 0.28
          ? "eerste kwartier"
          : fraction < 0.47
            ? "wassende maan"
            : fraction < 0.53
              ? "volle maan"
              : fraction < 0.72
                ? "afnemende maan"
                : fraction < 0.78
                  ? "laatste kwartier"
                  : "afnemende sikkel";
  const untilFull =
    (fraction < 0.5 ? 0.5 - fraction : 1.5 - fraction) * SYNODIC_DAYS;
  const untilNew = (1 - fraction) * SYNODIC_DAYS;
  return {
    name,
    fraction: Math.round(fraction * 1000) / 1000,
    illuminationPercent: Math.round(
      ((1 - Math.cos(2 * Math.PI * fraction)) / 2) * 100,
    ),
    waxing: fraction < 0.5,
    nextFull: new Date(date.getTime() + untilFull * 86400000)
      .toISOString()
      .slice(0, 10),
    nextNew: new Date(date.getTime() + untilNew * 86400000)
      .toISOString()
      .slice(0, 10),
  };
}

interface IssResponse {
  latitude: number;
  longitude: number;
  altitude: number;
  velocity: number;
  visibility: string;
  footprint: number;
}

export async function issPosition(
  http: WorldHttp,
  home: () => Promise<HomeLocation | null>,
  signal?: AbortSignal,
): Promise<IssPosition> {
  const d = await http.getJson<IssResponse>(
    "https://api.wheretheiss.at/v1/satellites/25544",
    signal,
  );
  const place = await home();
  const distance = place
    ? Math.round(
        distanceKm(place, { latitude: d.latitude, longitude: d.longitude }),
      )
    : null;
  return {
    latitude: Math.round(d.latitude * 100) / 100,
    longitude: Math.round(d.longitude * 100) / 100,
    altitudeKm: Math.round(d.altitude),
    speedKmh: Math.round(d.velocity),
    visibility: d.visibility,
    distanceFromHomeKm: distance,
    inRangeOfHome: distance != null && distance < d.footprint / 2,
    source: "wheretheiss.at",
    hint: "Noem de afstand tot het huis en de snelheid. Verzin geen landen of oceanen; je hebt alleen coordinaten.",
  };
}

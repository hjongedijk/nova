import type { WorldPlace } from "@nova/contracts";

const ROUTE_URL = "https://api.heigit.org/openrouteservice/v2/directions";
const MAX_RESPONSE_BYTES = 64 * 1024;
export type RouteMode = "driving-car" | "cycling-regular" | "foot-walking";

function coordinates(place: WorldPlace): [number, number] {
  if (
    !Number.isFinite(place.latitude) ||
    !Number.isFinite(place.longitude) ||
    Math.abs(place.latitude) > 90 ||
    Math.abs(place.longitude) > 180
  )
    throw new Error("Ongeldige routecoördinaten.");
  return [place.longitude, place.latitude];
}

async function smallJson(response: Response): Promise<unknown> {
  const declared = Number(response.headers.get("content-length"));
  if (declared > MAX_RESPONSE_BYTES) throw new Error("Routeantwoord te groot.");
  const reader = response.body?.getReader();
  if (!reader) throw new Error("Leeg routeantwoord.");
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_RESPONSE_BYTES) {
      await reader.cancel().catch(() => undefined);
      throw new Error("Routeantwoord te groot.");
    }
    chunks.push(value);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
}

/** Explicit, single-route request. Only coordinates leave NOVA; no live-traffic claim. */
export async function routeEstimate(
  apiKey: string,
  origin: WorldPlace,
  destination: WorldPlace,
  mode: RouteMode,
  signal?: AbortSignal,
  request: typeof fetch = fetch,
) {
  if (
    !apiKey ||
    !["driving-car", "cycling-regular", "foot-walking"].includes(mode)
  )
    throw new Error("Routebron is niet ingesteld.");
  const response = await request(`${ROUTE_URL}/${mode}`, {
    method: "POST",
    headers: {
      authorization: apiKey,
      "content-type": "application/json",
      accept: "application/json",
    },
    body: JSON.stringify({
      coordinates: [coordinates(origin), coordinates(destination)],
      geometry: false,
      instructions: false,
    }),
    redirect: "error",
    signal: signal
      ? AbortSignal.any([signal, AbortSignal.timeout(12000)])
      : AbortSignal.timeout(12000),
  });
  if (!response.ok) throw new Error("Routebron tijdelijk niet beschikbaar.");
  const data = (await smallJson(response)) as {
    routes?: Array<{ summary?: { distance?: unknown; duration?: unknown } }>;
  };
  const summary = data.routes?.[0]?.summary;
  const metres = summary?.distance;
  const seconds = summary?.duration;
  if (
    typeof metres !== "number" ||
    !Number.isFinite(metres) ||
    metres < 0 ||
    metres > 6_000_000 ||
    typeof seconds !== "number" ||
    !Number.isFinite(seconds) ||
    seconds < 0 ||
    seconds > 7 * 86400
  )
    throw new Error("Geen route gevonden.");
  return {
    origin: origin.name,
    destination: destination.name,
    mode,
    distanceKm: Math.round(metres / 100) / 10,
    durationMinutes: Math.ceil(seconds / 60),
    liveTraffic: false,
    attribution:
      "© openrouteservice.org by HeiGIT | Map data © OpenStreetMap contributors",
    note: "Geschatte reistijd zonder actuele verkeersdrukte.",
  };
}

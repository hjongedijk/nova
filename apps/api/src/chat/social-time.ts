const SEASONS = ["winter", "lente", "zomer", "herfst"] as const;

/** Local calendar context for conversational tone; this is not a source for live events. */
export function socialTimeContext(now: Date, timezone: string): string {
  const parts = new Intl.DateTimeFormat("nl-NL", {
    timeZone: timezone,
    weekday: "long",
    month: "numeric",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? "";
  const month = Number(get("month"));
  const hour = Number(get("hour"));
  const daypart =
    hour < 6 ? "nacht" : hour < 12 ? "ochtend" : hour < 18 ? "middag" : "avond";
  const season = SEASONS[Math.floor((month % 12) / 3)] ?? "";
  return `Lokale gesprekscontext: ${get("weekday")}, ${daypart}, ${season}. Gebruik dit alleen om een begroeting of toon natuurlijk af te stemmen; noem dagdeel of seizoen niet uit jezelf en behandel dit niet als agenda- of gebeurtenisdata.`;
}

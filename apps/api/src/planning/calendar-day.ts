import type { CalendarEvent } from "./caldav.service.js";

function partsAt(date: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);
  return Object.fromEntries(parts.map(({ type, value }) => [type, value]));
}

export function calendarDateKey(date: Date, timeZone: string): string {
  const p = partsAt(date, timeZone);
  return `${p.year}-${p.month}-${p.day}`;
}

function wallTimeAsInstant(value: string, timeZone: string): Date | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2}):(\d{2})$/.exec(value);
  if (!match) return null;
  try {
    const [year, month, day, hour, minute, second] = match.slice(1).map(Number);
    const target = Date.UTC(year!, month! - 1, day!, hour!, minute!, second!);
    let instant = target;
    for (let i = 0; i < 3; i++) {
      const p = partsAt(new Date(instant), timeZone);
      const represented = Date.UTC(
        Number(p.year),
        Number(p.month) - 1,
        Number(p.day),
        Number(p.hour),
        Number(p.minute),
        Number(p.second),
      );
      instant += target - represented;
    }
    return new Date(instant);
  } catch {
    // An invalid remote TZID cannot invalidate the rest of the agenda summary.
    return null;
  }
}

/** Selects calendar events whose start falls on the next local calendar day. */
export function eventsTomorrow(
  events: CalendarEvent[],
  now: Date,
  userTimeZone: string,
): CalendarEvent[] {
  const today = calendarDateKey(now, userTimeZone);
  const [year, month, day] = today.split("-").map(Number);
  const tomorrow = new Date(Date.UTC(year!, month! - 1, day! + 1))
    .toISOString()
    .slice(0, 10);
  return events.filter((event) => {
    if (event.allDay || !event.start.includes("T"))
      return event.start.slice(0, 10) === tomorrow;
    if (/(?:Z|[+-]\d{2}:?\d{2})$/i.test(event.start)) {
      const date = new Date(event.start);
      return (
        Number.isFinite(date.getTime()) &&
        calendarDateKey(date, userTimeZone) === tomorrow
      );
    }
    const instant = wallTimeAsInstant(
      event.start,
      event.timeZone || userTimeZone,
    );
    return (
      instant !== null && calendarDateKey(instant, userTimeZone) === tomorrow
    );
  });
}

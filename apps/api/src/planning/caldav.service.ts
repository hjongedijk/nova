import { Injectable } from "@nestjs/common";
import crypto from "node:crypto";
import { XMLParser } from "fast-xml-parser";
import { NovaConfig } from "../core/config/nova-config.js";
import {
  calendarDateKey,
  calendarEventStartInstant,
  wallTimeAsInstant,
} from "./calendar-day.js";

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string | null;
  timeZone: string | null;
  allDay: boolean;
}

interface CalendarRecord extends CalendarEvent {
  uid: string | null;
}

interface CalendarResource {
  href: string;
  etag: string;
  ics: string;
  events: CalendarRecord[];
}

const MAX_RESPONSE_BYTES = 2 * 1024 * 1024;
const MAX_EVENTS = 40;
const XML = new XMLParser({
  removeNSPrefix: true,
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  trimValues: true,
});

const asArray = <T>(value: T | T[] | undefined): T[] =>
  value === undefined ? [] : Array.isArray(value) ? value : [value];

const unescapeText = (value: string): string =>
  value
    .replace(/\\n/gi, " ")
    .replace(/\\([,;\\])/g, "$1")
    .split("")
    .map((character) =>
      (character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127) &&
      character !== "\t"
        ? " "
        : character,
    )
    .join("")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 160);

function eventDate(value: string): { value: string; allDay: boolean } | null {
  if (/^\d{8}$/.test(value))
    return {
      value: `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`,
      allDay: true,
    };
  const match = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z)?$/.exec(value);
  if (!match) return null;
  const [, year, month, day, hour, minute, second, utc] = match;
  return {
    value: `${year}-${month}-${day}T${hour}:${minute}:${second}${utc ? "Z" : ""}`,
    allDay: false,
  };
}

function parseCalendarData(
  ics: string,
  maxEvents = MAX_EVENTS,
): CalendarRecord[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const events: CalendarRecord[] = [];
  let fields: Map<string, { value: string; params: string }> | null = null;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") {
      fields = new Map();
      continue;
    }
    if (line === "END:VEVENT") {
      if (fields) {
        const start = fields.get("DTSTART");
        const parsedStart = start && eventDate(start.value);
        const summary = fields.get("SUMMARY")?.value;
        if (parsedStart && summary) {
          const end = fields.get("DTEND");
          const parsedEnd = end && eventDate(end.value);
          events.push({
            uid: fields.get("UID")?.value.trim() || null,
            summary: unescapeText(summary),
            start: parsedStart.value,
            end: parsedEnd?.value ?? null,
            timeZone: /(?:^|;)TZID=([^;:]+)/i.exec(start.params)?.[1] ?? null,
            allDay: parsedStart.allDay,
          });
        }
      }
      fields = null;
      if (events.length >= maxEvents) break;
      continue;
    }
    if (!fields) continue;
    const colon = line.indexOf(":");
    if (colon < 1) continue;
    const head = line.slice(0, colon);
    const semicolon = head.indexOf(";");
    const name = (
      semicolon < 0 ? head : head.slice(0, semicolon)
    ).toUpperCase();
    if (
      name !== "UID" &&
      name !== "DTSTART" &&
      name !== "DTEND" &&
      name !== "SUMMARY"
    )
      continue;
    fields.set(name, {
      value: line.slice(colon + 1).slice(0, 1000),
      params: semicolon < 0 ? "" : head.slice(semicolon + 1),
    });
  }
  return events;
}

@Injectable()
export class CalDavService {
  constructor(private readonly config: NovaConfig) {}

  get configured(): boolean {
    const { url, username, password } = this.config.calDav;
    return Boolean(url && username && password);
  }

  async upcoming(now = new Date()): Promise<CalendarEvent[]> {
    return (await this.upcomingRecords(now)).map(
      ({ summary, start, end, timeZone, allDay }) => ({
        summary,
        start,
        end,
        timeZone,
        allDay,
      }),
    );
  }

  /** Internal reminder path: stable iCalendar UIDs stay out of model-facing results. */
  async upcomingForReminders(
    now = new Date(),
  ): Promise<Array<{ event: CalendarEvent; uid: string | null }>> {
    return (await this.upcomingRecords(now)).map(({ uid, ...event }) => ({
      event,
      uid,
    }));
  }

  private async upcomingRecords(now: Date): Promise<CalendarRecord[]> {
    const { url, username, password } = this.config.calDav;
    if (!url || !username || !password) return [];
    let endpoint: URL;
    try {
      endpoint = new URL(url);
    } catch {
      throw new Error("De agenda-instelling is ongeldig.");
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("De agenda vereist een veilige HTTPS-kalender-URL.");

    const start = new Date(now);
    const end = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><C:calendar-data><C:expand start="${utcStamp(start)}" end="${utcStamp(end)}"/></C:calendar-data></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${utcStamp(start)}" end="${utcStamp(end)}"/></C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: "REPORT",
        redirect: "manual",
        signal: AbortSignal.timeout(8000),
        headers: {
          authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
          "content-type": "application/xml; charset=utf-8",
          depth: "1",
          accept: "application/xml",
        },
        body,
      });
    } catch {
      throw new Error("De agenda is nu niet bereikbaar.");
    }
    if (response.status !== 207)
      throw new Error(
        response.status === 401 || response.status === 403
          ? "De agenda-inlog is geweigerd. Controleer de serverinstellingen."
          : "De agenda gaf geen geldige reactie.",
      );
    const xml = await boundedText(response, MAX_RESPONSE_BYTES);
    let parsed: unknown;
    try {
      parsed = XML.parse(xml);
    } catch {
      throw new Error("De agenda gaf onleesbare gegevens terug.");
    }
    const root = parsed as { multistatus?: { response?: unknown } };
    const rows = asArray<Record<string, unknown>>(
      root?.multistatus?.response as
        Record<string, unknown> | Record<string, unknown>[] | undefined,
    );
    const events = rows.flatMap((row) => {
      const propstat = asArray(
        row.propstat as
          Record<string, unknown> | Record<string, unknown>[] | undefined,
      );
      return propstat.flatMap((item) => {
        const prop = item.prop as Record<string, unknown> | undefined;
        const data = prop?.["calendar-data"];
        return typeof data === "string"
          ? parseCalendarData(data, Number.POSITIVE_INFINITY)
          : [];
      });
    });
    const today = wallTimeAsInstant(
      `${calendarDateKey(now, this.config.timezone)}T00:00:00`,
      this.config.timezone,
    )?.getTime();
    return events
      .map((event) => ({
        event,
        instant: event.allDay
          ? wallTimeAsInstant(
              `${event.start}T00:00:00`,
              this.config.timezone,
            )?.getTime()
          : calendarEventStartInstant(event, this.config.timezone)?.getTime(),
        endInstant: event.end
          ? event.allDay
            ? wallTimeAsInstant(
                `${event.end}T00:00:00`,
                this.config.timezone,
              )?.getTime()
            : calendarEventStartInstant(
                { ...event, start: event.end },
                this.config.timezone,
              )?.getTime()
          : undefined,
      }))
      .filter(
        ({ event, instant, endInstant }) =>
          instant !== undefined &&
          (instant >=
            (event.allDay ? (today ?? start.getTime()) : start.getTime()) ||
            (endInstant !== undefined && endInstant > start.getTime())) &&
          instant < end.getTime(),
      )
      .sort((a, b) => a.instant! - b.instant!)
      .slice(0, MAX_EVENTS)
      .map(({ event }) => event);
  }

  async createEvent(input: {
    summary: string;
    start: string;
    end: string;
  }): Promise<Pick<CalendarEvent, "summary" | "start" | "end">> {
    const summary = eventSummary(input.summary);
    const start = requiredInstant(input.start);
    const end = requiredInstant(input.end);
    if (Date.parse(end) <= Date.parse(start))
      throw new Error("De eindtijd moet na de begintijd liggen.");
    const collection = this.collectionUrl();
    const uid = `${crypto.randomUUID()}@nova.local`;
    const url = new URL(`${encodeURIComponent(uid)}.ics`, collection);
    const ics = [
      "BEGIN:VCALENDAR",
      "VERSION:2.0",
      "PRODID:-//NOVA//NOVA Calendar//EN",
      "CALSCALE:GREGORIAN",
      "BEGIN:VEVENT",
      `UID:${uid}`,
      `DTSTAMP:${utcStamp(new Date())}`,
      `DTSTART:${utcStamp(new Date(start))}`,
      `DTEND:${utcStamp(new Date(end))}`,
      `SUMMARY:${escapeIcs(summary)}`,
      "END:VEVENT",
      "END:VCALENDAR",
      "",
    ].join("\r\n");
    const response = await this.request(url, {
      method: "PUT",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        ...this.authHeaders(),
        "content-type": "text/calendar; charset=utf-8",
        "if-none-match": "*",
      },
      body: ics,
    });
    if (response.status !== 201 && response.status !== 204)
      throw new Error("De afspraak kon niet worden opgeslagen.");
    return {
      summary,
      start,
      end,
    };
  }

  async moveEvent(input: {
    summary: string;
    oldStart: string;
    oldTimeZone?: string;
    newStart: string;
    newEnd: string;
  }): Promise<Pick<CalendarEvent, "summary" | "start" | "end">> {
    const summary = eventSummary(input.summary);
    const oldStart = requiredCalendarStart(input.oldStart);
    const newStart = requiredInstant(input.newStart);
    const newEnd = requiredInstant(input.newEnd);
    if (Date.parse(newEnd) <= Date.parse(newStart))
      throw new Error("De eindtijd moet na de begintijd liggen.");
    const oldInstant = calendarEventStartInstant(
      {
        start: oldStart,
        timeZone: input.oldTimeZone || this.config.timezone,
        allDay: false,
      },
      this.config.timezone,
    );
    if (!oldInstant)
      throw new Error("De begintijd van de afspraak is ongeldig.");
    const resources = await this.resourcesAround(oldInstant);
    const matches = resources.filter((resource) =>
      resource.events.some(
        (event) =>
          event.summary === summary &&
          calendarEventStartInstant(event, this.config.timezone)?.getTime() ===
            oldInstant.getTime(),
      ),
    );
    if (!matches.length)
      throw new Error(
        "Ik kan die afspraak niet meer vinden; er is niets gewijzigd.",
      );
    if (matches.length !== 1)
      throw new Error(
        "Er zijn meerdere passende afspraken; er is niets gewijzigd.",
      );
    const resource = matches[0]!;
    const unfolded = resource.ics.replace(/\r?\n[ \t]/g, "");
    if (
      hasRecurringEvent(unfolded) ||
      (unfolded.match(/^BEGIN:VEVENT$/gm) ?? []).length !== 1
    )
      throw new Error(
        "Terugkerende afspraken kunnen niet veilig worden verplaatst.",
      );
    const revised = replaceEventTimes(resource.ics, newStart, newEnd);
    const url = safeResourceUrl(resource.href, this.collectionUrl());
    const response = await this.request(url, {
      method: "PUT",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        ...this.authHeaders(),
        "content-type": "text/calendar; charset=utf-8",
        "if-match": resource.etag,
      },
      body: revised,
    });
    if (response.status === 412)
      throw new Error(
        "De afspraak is intussen gewijzigd; ik heb niets aangepast.",
      );
    if (response.status !== 201 && response.status !== 204)
      throw new Error("De afspraak kon niet worden verplaatst.");
    return { summary, start: newStart, end: newEnd };
  }

  private collectionUrl(): URL {
    const { url } = this.config.calDav;
    let endpoint: URL;
    try {
      endpoint = new URL(url);
    } catch {
      throw new Error("De agenda-instelling is ongeldig.");
    }
    if (
      endpoint.protocol !== "https:" ||
      endpoint.username ||
      endpoint.password ||
      endpoint.search ||
      endpoint.hash
    )
      throw new Error("De agenda vereist een veilige HTTPS-kalender-URL.");
    if (!endpoint.pathname.endsWith("/")) endpoint.pathname += "/";
    return endpoint;
  }

  private authHeaders(): Record<string, string> {
    const { username, password } = this.config.calDav;
    if (!username || !password)
      throw new Error("De agenda is niet geconfigureerd.");
    return {
      authorization: `Basic ${Buffer.from(`${username}:${password}`).toString("base64")}`,
    };
  }

  private async request(url: URL, init: RequestInit): Promise<Response> {
    let response: Response;
    try {
      response = await fetch(url, init);
    } catch {
      throw new Error("De agenda is nu niet bereikbaar.");
    }
    if (response.status >= 300 && response.status < 400)
      throw new Error("De agenda verwees door naar een andere locatie.");
    return response;
  }

  private async resourcesAround(oldStart: Date): Promise<CalendarResource[]> {
    const start = new Date(oldStart.getTime() - 48 * 60 * 60_000);
    const end = new Date(oldStart.getTime() + 48 * 60 * 60_000);
    const body = `<?xml version="1.0" encoding="utf-8"?>
<C:calendar-query xmlns:D="DAV:" xmlns:C="urn:ietf:params:xml:ns:caldav">
  <D:prop><D:getetag/><C:calendar-data/></D:prop>
  <C:filter><C:comp-filter name="VCALENDAR"><C:comp-filter name="VEVENT"><C:time-range start="${utcStamp(start)}" end="${utcStamp(end)}"/></C:comp-filter></C:comp-filter></C:filter>
</C:calendar-query>`;
    const response = await this.request(this.collectionUrl(), {
      method: "REPORT",
      redirect: "manual",
      signal: AbortSignal.timeout(8000),
      headers: {
        ...this.authHeaders(),
        "content-type": "application/xml; charset=utf-8",
        depth: "1",
        accept: "application/xml",
      },
      body,
    });
    if (response.status !== 207)
      throw new Error("De agenda kon de afspraak niet controleren.");
    const xml = await boundedText(response, MAX_RESPONSE_BYTES);
    let parsed: unknown;
    try {
      parsed = XML.parse(xml);
    } catch {
      throw new Error("De agenda gaf onleesbare gegevens terug.");
    }
    const root = parsed as { multistatus?: { response?: unknown } };
    const rows = asArray<Record<string, unknown>>(
      root?.multistatus?.response as
        Record<string, unknown> | Record<string, unknown>[] | undefined,
    );
    return rows.slice(0, MAX_EVENTS).flatMap((row) => {
      const propstats = asArray(
        row.propstat as
          Record<string, unknown> | Record<string, unknown>[] | undefined,
      );
      return propstats.flatMap((item) => {
        const prop = item.prop as Record<string, unknown> | undefined;
        const ics = prop?.["calendar-data"];
        const href = row.href;
        const etag = prop?.getetag;
        if (
          typeof ics !== "string" ||
          typeof href !== "string" ||
          typeof etag !== "string" ||
          !/^(?:W\/)?"[^"\r\n]{1,160}"$/.test(etag)
        )
          return [];
        return [{ href, etag, ics, events: parseCalendarData(ics) }];
      });
    });
  }
}

function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
}

function eventSummary(value: string): string {
  const summary = value.trim();
  if (
    !summary ||
    summary.length > 160 ||
    /[\r\n]/.test(summary) ||
    [...summary].some((character) => {
      const code = character.charCodeAt(0);
      return (code < 32 && code !== 9) || code === 127;
    })
  )
    throw new Error("De titel moet 1 tot 160 tekens bevatten.");
  return summary;
}

function requiredCalendarStart(value: string): string {
  const wallTime = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}$/.exec(value);
  if (wallTime) {
    requiredInstant(`${value}Z`);
    return value;
  }
  return requiredInstant(value);
}

function requiredInstant(value: string): string {
  const match =
    /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})(?::(\d{2})(?:\.(\d{1,3}))?)?(Z|[+-]\d{2}:\d{2})$/.exec(
      value,
    );
  if (!match) throw new Error("Gebruik een geldige ISO-tijd met tijdzone.");
  const [, year, month, day, hour, minute, second = "0", fraction = ""] = match;
  const date = new Date(
    `${year}-${month}-${day}T${hour}:${minute}:${second}.${fraction.padEnd(3, "0")}${match[8]}`,
  );
  const calendar = new Date(
    Date.UTC(Number(year), Number(month) - 1, Number(day)),
  );
  if (
    !Number.isFinite(date.getTime()) ||
    calendar.getUTCFullYear() !== Number(year) ||
    calendar.getUTCMonth() + 1 !== Number(month) ||
    calendar.getUTCDate() !== Number(day) ||
    Number(hour) > 23 ||
    Number(minute) > 59 ||
    Number(second) > 59
  )
    throw new Error("Gebruik een geldige ISO-tijd met tijdzone.");
  return date.toISOString();
}

function escapeIcs(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/;/g, "\\;").replace(/,/g, "\\,");
}

function replaceEventTimes(ics: string, start: string, end: string): string {
  let starts = 0;
  let ends = 0;
  let inEvent = false;
  const lines = ics.split(/\r?\n/).map((line) => {
    if (line === "BEGIN:VEVENT") inEvent = true;
    if (inEvent && /^DTSTART(?:;[^:]*)?:/.test(line)) {
      starts++;
      return `DTSTART:${utcStamp(new Date(start))}`;
    }
    if (inEvent && /^DTEND(?:;[^:]*)?:/.test(line)) {
      ends++;
      return `DTEND:${utcStamp(new Date(end))}`;
    }
    if (line === "END:VEVENT") inEvent = false;
    return line;
  });
  if (starts !== 1 || ends !== 1)
    throw new Error(
      "De afspraak heeft geen veilig bewerkbare begin- en eindtijd.",
    );
  return lines.join("\r\n");
}

function hasRecurringEvent(unfoldedCalendar: string): boolean {
  let inEvent = false;
  for (const line of unfoldedCalendar.split(/\r?\n/)) {
    if (line === "BEGIN:VEVENT") inEvent = true;
    else if (line === "END:VEVENT") inEvent = false;
    else if (
      inEvent &&
      /^(?:RRULE|RDATE|EXDATE|RECURRENCE-ID)(?:;[^:]*)?:/.test(line)
    )
      return true;
  }
  return false;
}

function safeResourceUrl(href: string, collection: URL): URL {
  let target: URL;
  try {
    target = new URL(href, collection);
  } catch {
    throw new Error("De agenda gaf een ongeldige afspraaklocatie terug.");
  }
  if (
    target.protocol !== "https:" ||
    target.origin !== collection.origin ||
    target.username ||
    target.password ||
    target.search ||
    target.hash ||
    !target.pathname.startsWith(collection.pathname) ||
    target.pathname === collection.pathname
  )
    throw new Error("De agenda gaf een ongeldige afspraaklocatie terug.");
  return target;
}

async function boundedText(
  response: Response,
  maximum: number,
): Promise<string> {
  if (!response.body) return "";
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > maximum) throw new Error("Calendar response too large");
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(output);
}

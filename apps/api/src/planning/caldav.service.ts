import { Injectable } from "@nestjs/common";
import { XMLParser } from "fast-xml-parser";
import { NovaConfig } from "../core/config/nova-config.js";

export interface CalendarEvent {
  summary: string;
  start: string;
  end: string | null;
  timeZone: string | null;
  allDay: boolean;
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

function parseCalendarData(ics: string): CalendarEvent[] {
  const unfolded = ics.replace(/\r?\n[ \t]/g, "");
  const lines = unfolded.split(/\r?\n/);
  const events: CalendarEvent[] = [];
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
            summary: unescapeText(summary),
            start: parsedStart.value,
            end: parsedEnd?.value ?? null,
            timeZone: /(?:^|;)TZID=([^;:]+)/i.exec(start.params)?.[1] ?? null,
            allDay: parsedStart.allDay,
          });
        }
      }
      fields = null;
      if (events.length >= MAX_EVENTS) break;
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
    if (name !== "DTSTART" && name !== "DTEND" && name !== "SUMMARY") continue;
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
        | Record<string, unknown>
        | Record<string, unknown>[]
        | undefined,
    );
    const events = rows.flatMap((row) => {
      const propstat = asArray(
        row.propstat as
          Record<string, unknown> | Record<string, unknown>[] | undefined,
      );
      return propstat.flatMap((item) => {
        const prop = item.prop as Record<string, unknown> | undefined;
        const data = prop?.["calendar-data"];
        return typeof data === "string" ? parseCalendarData(data) : [];
      });
    });
    return events
      .sort((a, b) => a.start.localeCompare(b.start))
      .slice(0, MAX_EVENTS);
  }
}

function utcStamp(date: Date): string {
  return date
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");
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

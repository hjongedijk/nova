import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../../src/planning/caldav.service.js";
import { eventsTomorrow } from "../../src/planning/calendar-day.js";

const event = (
  summary: string,
  start: string,
  timeZone: string | null = null,
  allDay = false,
): CalendarEvent => ({
  summary,
  start,
  end: null,
  timeZone,
  allDay,
});

describe("eventsTomorrow", () => {
  it("filters all-day, floating, zoned, and UTC events by the user's local date", () => {
    const now = new Date("2024-03-31T22:30:00.000Z"); // Apr 1, 00:30 in Amsterdam
    const events = [
      event("today", "2024-04-01T10:00:00", "Europe/Amsterdam"),
      event("all day tomorrow", "2024-04-02", null, true),
      event("floating tomorrow", "2024-04-02T09:00:00"),
      event("UTC tomorrow", "2024-04-01T22:30:00Z"),
      event("earlier tomorrow", "2024-04-02T01:00:00", "Europe/Amsterdam"),
      event("invalid timezone", "2024-04-02T09:00:00", "Not/A_Timezone"),
    ];
    expect(
      eventsTomorrow(events, now, "Europe/Amsterdam").map(
        (item) => item.summary,
      ),
    ).toEqual([
      "all day tomorrow",
      "floating tomorrow",
      "UTC tomorrow",
      "earlier tomorrow",
    ]);
  });
});

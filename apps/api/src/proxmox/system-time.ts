const HOURS = [
  "twaalf",
  "een",
  "twee",
  "drie",
  "vier",
  "vijf",
  "zes",
  "zeven",
  "acht",
  "negen",
  "tien",
  "elf",
];

/** "tien voor zes": the time as it is said out loud, rounded to five minutes. */
export function spokenTime(
  hours: number,
  minutes: number,
): { spoken: string; partOfDay: string } {
  let h = hours;
  let m = Math.round(minutes / 5) * 5;
  if (m === 60) {
    m = 0;
    h = (h + 1) % 24;
  }
  const hour = (x: number) => HOURS[x % 12];
  const next = hour(h + 1);
  const phrases: Record<number, string> = {
    0: `${hour(h)} uur`,
    5: `vijf over ${hour(h)}`,
    10: `tien over ${hour(h)}`,
    15: `kwart over ${hour(h)}`,
    20: `tien voor half ${next}`,
    25: `vijf voor half ${next}`,
    30: `half ${next}`,
    35: `vijf over half ${next}`,
    40: `tien over half ${next}`,
    45: `kwart voor ${next}`,
    50: `tien voor ${next}`,
    55: `vijf voor ${next}`,
  };
  const part =
    hours < 6
      ? "nacht"
      : hours < 12
        ? "ochtend"
        : hours < 18
          ? "middag"
          : "avond";
  return { spoken: phrases[m] ?? "", partOfDay: part };
}

/** Hour and minute on the wall clock of a time zone. */
export function clockIn(now: Date, timeZone: string) {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone,
    hour: "numeric",
    minute: "numeric",
    hourCycle: "h23",
  }).formatToParts(now);
  const pick = (type: string) =>
    Number(parts.find((p) => p.type === type)?.value ?? 0);
  return { hours: pick("hour") % 24, minutes: pick("minute") };
}

/** Dutch local date and time pieces, in the configured time zone. */
export function localTime(now: Date, timeZone: string) {
  const { hours, minutes } = clockIn(now, timeZone);
  return {
    weekday: now.toLocaleDateString("nl-NL", { weekday: "long", timeZone }),
    date: now.toLocaleDateString("nl-NL", {
      day: "numeric",
      month: "long",
      year: "numeric",
      timeZone,
    }),
    time: now.toLocaleTimeString("nl-NL", {
      hour: "2-digit",
      minute: "2-digit",
      timeZone,
    }),
    ...spokenTime(hours, minutes),
  };
}

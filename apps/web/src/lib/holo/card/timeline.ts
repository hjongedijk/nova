import type { VizScene, VizTimelineItem } from "../types.ts";
import { emptyLayout, type CardLayout } from "./types.ts";
import { PAD, finish, fit, textWidth } from "./common.ts";

const LANE_H = 34;
const LANE_GAP = 8;
const MIN = 60_000;
const STEPS = [1, 2, 5, 10, 15, 30, 60, 120, 180, 360, 720].map((m) => m * MIN);

export function clockFormatter(timeZone: string): (ms: number) => string {
  const make = (zone: string | undefined) =>
    new Intl.DateTimeFormat("nl-NL", {
      ...(zone ? { timeZone: zone } : {}),
      hour: "2-digit",
      minute: "2-digit",
      hourCycle: "h23",
    });
  let format: Intl.DateTimeFormat;
  try {
    format = make(timeZone);
  } catch {
    format = make(undefined);
  }
  return (ms) => format.format(new Date(ms));
}

/** Words for a span: "8 min", "1 u 5 min". */
export function durationText(ms: number): string {
  const minutes = Math.max(0, Math.round(ms / MIN));
  if (minutes < 1) return `${Math.max(0, Math.round(ms / 1000))} s`;
  if (minutes < 60) return `${minutes} min`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m ? `${h} u ${m} min` : `${h} u`;
}

export interface TimelineWindow {
  from: number;
  to: number;
}

/** The part of the day that is worth drawing: the items and "now", rounded outwards. */
export function timelineWindow(scene: VizScene): TimelineWindow {
  const timeline = scene.timeline!;
  const dayStart = Date.parse(timeline.start);
  const dayEnd = Date.parse(timeline.end);
  const now = Date.parse(timeline.now);
  const times: number[] = [];
  let timers = 0;
  for (const item of timeline.items) {
    if (item.allDay) continue;
    if (item.kind === "timer") timers++;
    times.push(Date.parse(item.start));
    times.push(
      item.end ? Date.parse(item.end) : Date.parse(item.start) + 30 * MIN,
    );
  }
  if (now >= dayStart && now <= dayEnd) times.push(now);
  if (!times.length)
    return { from: dayStart + 6 * 3_600_000, to: dayStart + 22 * 3_600_000 };
  let from = Math.max(dayStart, Math.min(...times));
  let to = Math.min(dayEnd, Math.max(...times));
  if (timers === timeline.items.length) {
    // Countdowns: from now to the last one, with a little air on the right.
    to = to + Math.max(MIN, (to - from) * 0.06);
    return { from, to: Math.max(to, from + 2 * MIN) };
  }
  const hour = 3_600_000;
  from = Math.max(dayStart, Math.floor((from - 20 * MIN) / hour) * hour);
  to = Math.min(dayEnd, Math.ceil((to + 20 * MIN) / hour) * hour);
  if (to - from < 6 * hour) {
    const mid = (from + to) / 2;
    from = Math.max(dayStart, Math.floor((mid - 3 * hour) / hour) * hour);
    to = Math.min(dayEnd, from + 6 * hour);
    from = Math.max(dayStart, to - 6 * hour);
  }
  return { from, to };
}

/** Events and timers on a time axis, with a "nu" marker. Past items are dimmed. */
export function layoutTimeline(scene: VizScene, width: number): CardLayout {
  const timeline = scene.timeline;
  const out = emptyLayout(width, 120);
  if (!timeline) return out;
  const clock = clockFormatter(timeline.timeZone);
  const win = timelineWindow(scene);
  const now = Date.parse(timeline.now);
  const left = PAD;
  const right = width - PAD;
  const axisW = right - left;
  const x = (ms: number) =>
    left +
    ((Math.min(win.to, Math.max(win.from, ms)) - win.from) /
      (win.to - win.from)) *
      axisW;
  const showNow = now >= win.from && now <= win.to;

  let top = 30;
  const allDay = timeline.items.filter((item) => item.allDay);
  for (const [i, item] of allDay.entries()) {
    out.shapes.push({
      id: `day:${item.id}`,
      type: "box",
      tone: "accent",
      style: "ghost",
      tip: `${item.label} (hele dag)`,
      x: left,
      y: top,
      w: axisW,
      h: 22,
      d: 6,
      z: -6,
      appear: 0.05 * i,
    });
    out.labels.push({
      id: `dayl:${item.id}`,
      x: left + 8,
      y: top + 15,
      z: 0,
      text: `${fit(item.label, axisW - 90, "sm")}`,
      anchor: "start",
      tone: "text",
      size: "sm",
    });
    out.labels.push({
      id: `dayt:${item.id}`,
      x: right - 8,
      y: top + 15,
      z: 0,
      text: "hele dag",
      anchor: "end",
      tone: "dim",
      size: "xs",
    });
    top += 28;
  }
  if (allDay.length) top += 4;

  interface Placed {
    item: VizTimelineItem;
    x0: number;
    x1: number;
    outside: boolean;
    text: string;
    lane: number;
  }
  const timed = timeline.items
    .filter((item) => !item.allDay)
    .map((item) => ({
      item,
      from: Date.parse(item.start),
      to: item.end ? Date.parse(item.end) : Date.parse(item.start) + 30 * MIN,
    }))
    .sort((a, b) => a.from - b.from || a.to - b.to);
  const laneEnds: number[] = [];
  const placed: Placed[] = timed.map(({ item, from, to }) => {
    const x0 = x(from);
    const x1 = Math.max(x0 + 8, x(to));
    const text =
      item.kind === "timer"
        ? `${item.label} · nog ${durationText(Math.max(0, to - now))}`
        : item.label;
    const inside = textWidth(text, "sm") + 16 <= x1 - x0;
    const outside = !inside && x1 + 8 + textWidth(text, "sm") <= right;
    const extent = inside
      ? x1
      : outside
        ? x1 + 8 + textWidth(text, "sm")
        : Math.max(x1, x0 + 40);
    let lane = laneEnds.findIndex((end) => end + 6 <= x0);
    if (lane < 0) lane = laneEnds.length;
    laneEnds[lane] = extent;
    return { item, x0, x1, outside, text, lane };
  });
  const lanes = Math.max(1, laneEnds.length);
  const laneTop = top;
  placed.forEach((p, index) => {
    const y = laneTop + p.lane * (LANE_H + LANE_GAP);
    const isTimer = p.item.kind === "timer";
    const ends = p.item.end
      ? Date.parse(p.item.end)
      : Date.parse(p.item.start) + 30 * MIN;
    const past = ends < now;
    const live = Date.parse(p.item.start) <= now && now <= ends && !isTimer;
    const tip = isTimer
      ? `Timer ${p.item.label}: gaat af om ${clock(ends)} (over ${durationText(Math.max(0, ends - now))})`
      : `${p.item.label}: ${clock(Date.parse(p.item.start))}${p.item.end ? `–${clock(ends)}` : ""}${past ? " (voorbij)" : live ? " (bezig)" : ""}`;
    out.shapes.push({
      id: `item:${p.item.id}`,
      type: "box",
      tone: isTimer ? "warm" : past ? "muted" : "accent",
      style: past ? "ghost" : "solid",
      tip,
      x: p.x0,
      y,
      w: Math.max(8, p.x1 - p.x0),
      h: LANE_H,
      d: live ? 20 : 12,
      z: 0,
      appear: 0.1 + (index / Math.max(1, placed.length)) * 0.5,
    });
    const inside = !p.outside && textWidth(p.text, "sm") + 16 <= p.x1 - p.x0;
    const label = inside
      ? p.text
      : p.outside
        ? p.text
        : fit(p.text, Math.max(30, p.x1 - p.x0 - 12), "sm");
    out.labels.push({
      id: `il:${p.item.id}`,
      x: p.outside ? p.x1 + 8 : p.x0 + 8,
      y: y + 15,
      z: 12,
      text: label,
      anchor: "start",
      tone: past ? "dim" : "text",
      size: "sm",
      bold: !past,
    });
    const timeText = isTimer
      ? clock(ends)
      : `${clock(Date.parse(p.item.start))}${p.item.end ? `–${clock(ends)}` : ""}`;
    out.labels.push({
      id: `it:${p.item.id}`,
      x: p.outside ? p.x1 + 8 : p.x0 + 8,
      y: y + 29,
      z: 12,
      text: timeText,
      anchor: "start",
      tone: "dim",
      size: "xs",
    });
  });
  const axisY = laneTop + lanes * (LANE_H + LANE_GAP) + 6;

  // Axis, ticks and vertical grid.
  const span = win.to - win.from;
  const step =
    STEPS.find((s) => (s / span) * axisW >= 58) ?? STEPS[STEPS.length - 1]!;
  const first = Math.ceil(win.from / step) * step;
  out.lines.push({
    id: "axis",
    kind: "axis",
    pts: [
      [left, axisY],
      [right, axisY],
    ],
    z: 0,
    tone: "muted",
    width: 1.5,
  });
  for (let t = first; t <= win.to + 1; t += step) {
    const tx = x(t);
    out.lines.push({
      id: `grid:${t}`,
      kind: "grid",
      pts: [
        [tx, top - 4],
        [tx, axisY],
      ],
      z: -10,
      tone: "muted",
      width: 1,
    });
    out.labels.push({
      id: `tick:${t}`,
      x: tx,
      y: axisY + 17,
      z: 0,
      text: clock(t),
      anchor: "middle",
      tone: "dim",
      size: "xs",
    });
  }
  if (showNow) {
    const nx = x(now);
    out.lines.push({
      id: "now-line",
      kind: "marker",
      pts: [
        [nx, 22],
        [nx, axisY],
      ],
      z: 24,
      tone: "accent",
      width: 2,
    });
    out.shapes.push({
      id: "now-blade",
      type: "box",
      tone: "accent",
      style: "ghost",
      tip: `Nu: ${clock(now)}`,
      x: nx - 1.5,
      y: 24,
      w: 3,
      h: axisY - 24,
      d: 40,
      z: 0,
      appear: 0.8,
    });
    const text = `Nu ${clock(now)}`;
    const half = textWidth(text, "xs", true) / 2;
    out.labels.push({
      id: "now-label",
      x: Math.min(right - half, Math.max(left + half, nx)),
      y: 14,
      z: 24,
      text,
      anchor: "middle",
      tone: "accent",
      size: "xs",
      bold: true,
    });
  }
  out.height = axisY + 28;
  out.legend = [
    ...(timeline.items.some((item) => item.kind === "event")
      ? [{ tone: "accent" as const, label: "Afspraak" }]
      : []),
    ...(timeline.items.some((item) => item.kind === "timer")
      ? [{ tone: "warm" as const, label: "Timer" }]
      : []),
  ];
  return finish(out);
}

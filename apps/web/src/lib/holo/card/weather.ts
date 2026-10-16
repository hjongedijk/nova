import type { VizScene } from "../types.ts";
import { emptyLayout, type CardLayout, type GlyphName } from "./types.ts";
import {
  PAD,
  finish,
  fit,
  niceTicks,
  num,
  smooth,
  textWidth,
} from "./common.ts";

interface Slot {
  label: string;
  temp: number | null;
  temp2: number | null;
  rain: number | null;
  glyph: GlyphName;
  condition: string;
}

const HEAD = 62;
const TEMP_TOP = 40 + HEAD;
const TEMP_H = 96;
const RAIN_TOP = TEMP_TOP + TEMP_H + 14;
const RAIN_H = 34;
const DAYS_TOP = RAIN_TOP + RAIN_H + 66;

const deg = (value: number) => `${Math.round(value)}°`;

/** Temperature curve, rain bars and condition glyphs (hours), with a strip of days below. */
export function layoutWeather(scene: VizScene, width: number): CardLayout {
  const weather = scene.weather;
  const out = emptyLayout(width, 120);
  if (!weather) return out;
  const hoursMode = weather.hours.some((hour) => hour.temperature !== null);
  const slots: Slot[] = hoursMode
    ? weather.hours.map((hour) => ({
        label: hour.label,
        temp: hour.temperature,
        temp2: null,
        rain: hour.rainPercent,
        glyph: hour.glyph,
        condition: hour.condition,
      }))
    : weather.days.map((day) => ({
        label: day.label,
        temp: day.max,
        temp2: day.min,
        rain: day.rainPercent,
        glyph: day.glyph,
        condition: day.condition,
      }));
  const left = 38;
  const right = width - PAD;
  const plotW = Math.max(60, right - left);
  const n = Math.max(1, slots.length);
  const slot = plotW / n;
  const cx = (i: number) => left + (i + 0.5) * slot;

  const values = slots.flatMap((s) =>
    [s.temp, s.temp2].filter((v): v is number => v !== null),
  );
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const pad = Math.max(1, (hi - lo) * 0.12);
  const scale = niceTicks(lo - pad, hi + pad, 3);
  const yOf = (t: number) =>
    TEMP_TOP +
    TEMP_H -
    ((t - scale.min) / (scale.max - scale.min || 1)) * TEMP_H;

  if (weather.now && weather.now.temperature !== null) {
    const now = weather.now;
    const nowTemp = weather.now.temperature;
    out.glyphs.push({
      id: "now-glyph",
      x: PAD + 20,
      y: 30,
      z: 8,
      size: 40,
      glyph: now.glyph,
      tone: "text",
      title: now.condition,
    });
    out.labels.push({
      id: "now-temp",
      x: PAD + 50,
      y: 40,
      z: 8,
      text: deg(nowTemp),
      anchor: "start",
      tone: "text",
      size: "xl",
      bold: true,
    });
    const extra = [
      now.feelsLike != null ? `voelt als ${deg(now.feelsLike)}` : "",
      now.windKmh != null ? `wind ${Math.round(now.windKmh)} km/u` : "",
      now.humidityPercent != null
        ? `${Math.round(now.humidityPercent)}% vochtig`
        : "",
    ].filter(Boolean);
    const x0 = PAD + 50 + textWidth(deg(nowTemp), "xl", true) + 14;
    out.labels.push({
      id: "now-cond",
      x: x0,
      y: 26,
      z: 8,
      text: `Nu: ${now.condition}`,
      anchor: "start",
      tone: "text",
      size: "md",
      bold: true,
    });
    out.labels.push({
      id: "now-extra",
      x: x0,
      y: 44,
      z: 8,
      text: fit(extra.join(" · "), width - x0 - PAD, "xs"),
      anchor: "start",
      tone: "dim",
      size: "xs",
    });
  }

  // Grid and the temperature axis.
  for (const tick of scale.ticks) {
    const y = yOf(tick);
    out.lines.push({
      id: `grid:${tick}`,
      kind: "grid",
      pts: [
        [left, y],
        [right, y],
      ],
      z: -12,
      tone: "muted",
      width: 1,
    });
    out.labels.push({
      id: `ytick:${tick}`,
      x: left - 6,
      y: y + 4,
      z: 0,
      text: deg(tick),
      anchor: "end",
      tone: "dim",
      size: "xs",
    });
  }

  // Curve (and the min curve for a day-only forecast), with the area under it.
  const known = slots
    .map((s, i) => ({ i, t: s.temp }))
    .filter((p): p is { i: number; t: number } => p.t !== null);
  const curve = smooth(
    known.map((p) => [cx(p.i), yOf(p.t)] as [number, number]),
  );
  if (curve.length > 1) {
    out.shapes.push({
      id: "temp-area",
      type: "area",
      tone: "warm",
      style: "ghost",
      tip: hoursMode ? "Temperatuur per uur" : "Hoogste temperatuur per dag",
      pts: curve,
      baseY: TEMP_TOP + TEMP_H,
      d: 10,
      z: -4,
      appear: 0.1,
    });
    out.lines.push({
      id: "temp-curve",
      kind: "curve",
      pts: curve,
      z: 6,
      tone: "warm",
      width: 2.5,
    });
  }
  if (!hoursMode) {
    const low = slots
      .map((s, i) => ({ i, t: s.temp2 }))
      .filter((p): p is { i: number; t: number } => p.t !== null);
    const lowCurve = smooth(
      low.map((p) => [cx(p.i), yOf(p.t)] as [number, number]),
    );
    if (lowCurve.length > 1)
      out.lines.push({
        id: "temp-low",
        kind: "curve",
        pts: lowCurve,
        z: 6,
        tone: "accent",
        width: 2,
        dashed: true,
      });
  }

  // Temperature labels: the extremes, plus a regular one when there is room.
  const every = Math.max(1, Math.ceil(34 / slot));
  const iMax = known.reduce(
    (a, p) => (p.t > known[a]!.t ? known.indexOf(p) : a),
    0,
  );
  const iMin = known.reduce(
    (a, p) => (p.t < known[a]!.t ? known.indexOf(p) : a),
    0,
  );
  known.forEach((p, k) => {
    const extreme = k === iMax || k === iMin;
    if (!extreme && (p.i % every !== 0 || n > 14)) return;
    out.labels.push({
      id: `t:${p.i}`,
      x: cx(p.i),
      y: yOf(p.t) - 9,
      z: 8,
      text: deg(p.t),
      anchor: "middle",
      tone: extreme ? "text" : "dim",
      size: "xs",
      bold: extreme,
    });
  });
  if (!hoursMode) {
    slots.forEach((s, i) => {
      if (s.temp2 !== null)
        out.labels.push({
          id: `tl:${i}`,
          x: cx(i),
          y: yOf(s.temp2) + 17,
          z: 8,
          text: deg(s.temp2),
          anchor: "middle",
          tone: "dim",
          size: "xs",
        });
    });
  }

  // Glyph row.
  const gEvery = Math.max(1, Math.ceil(34 / slot));
  slots.forEach((s, i) => {
    if (i % gEvery !== 0) return;
    out.glyphs.push({
      id: `g:${i}`,
      x: cx(i),
      y: 16 + HEAD,
      z: 8,
      size: 24,
      glyph: s.glyph,
      tone: "text",
      title: `${s.label}: ${s.condition}`,
    });
  });

  // Rain bars (chance, 0..100%) in their own band.
  out.labels.push({
    id: "rain-title",
    x: left - 6,
    y: RAIN_TOP + RAIN_H / 2 + 4,
    z: 0,
    text: "Regen",
    anchor: "end",
    tone: "rain",
    size: "xs",
  });
  out.lines.push({
    id: "rain-base",
    kind: "axis",
    pts: [
      [left, RAIN_TOP + RAIN_H],
      [right, RAIN_TOP + RAIN_H],
    ],
    z: 0,
    tone: "muted",
    width: 1,
  });
  const barW = Math.max(3, Math.min(26, slot * 0.58));
  slots.forEach((s, i) => {
    const percent = s.rain;
    if (percent === null) {
      out.shapes.push({
        id: `rain:${i}`,
        type: "box",
        tone: "unknown",
        style: "dashed",
        tip: `${s.label}: regenkans onbekend`,
        x: cx(i) - barW / 2,
        y: RAIN_TOP + RAIN_H - 4,
        w: barW,
        h: 4,
        d: 4,
        z: 0,
        appear: 0.3,
      });
      return;
    }
    const h = Math.max(2, (percent / 100) * RAIN_H);
    out.shapes.push({
      id: `rain:${i}`,
      type: "box",
      tone: "rain",
      style: percent === 0 ? "ghost" : "solid",
      tip: `${s.label}: ${percent}% kans op regen`,
      x: cx(i) - barW / 2,
      y: RAIN_TOP + RAIN_H - h,
      w: barW,
      h,
      d: 14,
      z: 0,
      appear: 0.3 + (i / n) * 0.4,
    });
    if (
      percent >= 20 &&
      slot >= 26 &&
      i % Math.max(1, Math.ceil(30 / slot)) === 0
    )
      out.labels.push({
        id: `rp:${i}`,
        x: cx(i),
        y: RAIN_TOP + RAIN_H - h - 5,
        z: 14,
        text: `${percent}%`,
        anchor: "middle",
        tone: "rain",
        size: "xs",
      });
  });

  // Time labels.
  const longLabel = slots[0] ? textWidth(slots[0].label, "xs") : 0;
  const lEvery = Math.max(1, Math.ceil((longLabel + 12) / slot));
  slots.forEach((s, i) => {
    if (i % lEvery !== 0) return;
    out.labels.push({
      id: `x:${i}`,
      x: cx(i),
      y: RAIN_TOP + RAIN_H + 17,
      z: 0,
      text: hoursMode
        ? i === 0
          ? "nu"
          : s.label
        : fit(s.label, slot * lEvery - 4, "xs"),
      anchor: "middle",
      tone: i === 0 && hoursMode ? "accent" : "dim",
      size: "xs",
      bold: i === 0 && hoursMode,
    });
  });
  // Days strip, only when the curve above is by hour and there is more than today.
  let height = RAIN_TOP + RAIN_H + 40;
  if (hoursMode && weather.days.length > 1) {
    const days = weather.days;
    const colW = (width - 2 * PAD) / days.length;
    out.lines.push({
      id: "days-rule",
      kind: "grid",
      pts: [
        [PAD, DAYS_TOP - 14],
        [width - PAD, DAYS_TOP - 14],
      ],
      z: -12,
      tone: "muted",
      width: 1,
    });
    days.forEach((day, i) => {
      const mid = PAD + (i + 0.5) * colW;
      const name =
        textWidth(day.label, "xs") <= colW - 6
          ? day.label
          : day.label === "vandaag"
            ? "nu"
            : day.label.slice(0, 3);
      out.labels.push({
        id: `dn:${i}`,
        x: mid,
        y: DAYS_TOP,
        z: 0,
        text: name,
        anchor: "middle",
        tone: i === 0 ? "accent" : "dim",
        size: "xs",
        bold: i === 0,
      });
      out.glyphs.push({
        id: `dg:${i}`,
        x: mid,
        y: DAYS_TOP + 22,
        z: 4,
        size: 24,
        glyph: day.glyph,
        tone: "text",
        title: `${day.label}: ${day.condition}`,
      });
      out.labels.push({
        id: `dm:${i}`,
        x: mid,
        y: DAYS_TOP + 50,
        z: 0,
        text: day.max === null ? "–" : deg(day.max),
        anchor: "middle",
        tone: "text",
        size: "md",
        bold: true,
      });
      out.labels.push({
        id: `dl:${i}`,
        x: mid,
        y: DAYS_TOP + 66,
        z: 0,
        text: day.min === null ? "–" : deg(day.min),
        anchor: "middle",
        tone: "dim",
        size: "xs",
      });
      const mm = day.rainMm;
      const w = Math.min(22, colW * 0.5);
      if (mm !== null) {
        const h = Math.max(2, Math.min(1, mm / 10) * 22);
        out.shapes.push({
          id: `dr:${i}`,
          type: "box",
          tone: "rain",
          style: mm === 0 ? "ghost" : "solid",
          tip: `${day.label}: ${num(mm)} mm regen${day.rainPercent !== null ? `, ${day.rainPercent}% kans` : ""}`,
          x: mid - w / 2,
          y: DAYS_TOP + 100 - h,
          w,
          h,
          d: 10,
          z: 0,
          appear: 0.5 + i * 0.05,
        });
        if (mm > 0 && colW >= 40)
          out.labels.push({
            id: `dmm:${i}`,
            x: mid,
            y: DAYS_TOP + 114,
            z: 0,
            text: `${num(mm)} mm`,
            anchor: "middle",
            tone: "rain",
            size: "xs",
          });
      }
    });
    height = DAYS_TOP + 124;
  }
  out.height = height;
  out.legend = [
    { tone: "warm", label: "Temperatuur" },
    { tone: "rain", label: hoursMode ? "Kans op regen" : "Regenkans" },
  ];
  return finish(out);
}

import type { VizScene } from "../types.ts";
import { emptyLayout, type CardLayout, type Tone } from "./types.ts";
import { PAD, finish, niceTicks, num, textWidth, toneOf } from "./common.ts";

const TOP = 34;
const SERIES_TONES: Tone[] = ["accent", "rain", "warm", "ok"];

/** A clean 3D bar/area chart: axes, units, grid on the back wall and the latest value called out. */
export function layoutSeries(scene: VizScene, width: number): CardLayout {
  const chart = scene.chart;
  const out = emptyLayout(width, 120);
  if (!chart) return out;
  const labels = [
    ...new Set(chart.series.flatMap((s) => s.points.map((p) => p.label))),
  ];
  const n = Math.max(1, labels.length);
  const all = chart.series.flatMap((s) =>
    s.points.map((p) => p.value).filter((v): v is number => v !== null),
  );
  const dataMax = all.length ? Math.max(...all) : 1;
  const dataMin = all.length ? Math.min(0, ...all) : 0;
  const scale = niceTicks(dataMin, chart.max ?? Math.max(dataMax, 1e-9), 4);
  const max = chart.max ?? scale.max;
  const left =
    8 + Math.max(...scale.ticks.map((t) => textWidth(num(t), "xs"))) + 8;
  const right = width - PAD;
  const plotW = right - left;
  const plotH = width < 420 ? 150 : 176;
  const bottom = TOP + plotH;
  const slot = plotW / n;
  const yOf = (value: number) =>
    bottom - ((value - scale.min) / (max - scale.min || 1)) * plotH;
  const groupW = Math.max(4, Math.min(48, slot * 0.72));
  const count = chart.series.length;
  const barW = Math.max(3, groupW / count - (count > 1 ? 2 : 0));

  for (const tick of scale.ticks) {
    if (tick > max + 1e-9) continue;
    const y = yOf(tick);
    out.lines.push({
      id: `grid:${tick}`,
      kind: tick === 0 ? "axis" : "grid",
      pts: [
        [left, y],
        [right, y],
      ],
      z: tick === 0 ? 0 : -14,
      tone: "muted",
      width: tick === 0 ? 1.5 : 1,
    });
    out.labels.push({
      id: `ytick:${tick}`,
      x: left - 7,
      y: y + 4,
      z: 0,
      text: num(tick),
      anchor: "end",
      tone: "dim",
      size: "xs",
    });
  }
  if (chart.unit)
    out.labels.push({
      id: "unit",
      x: PAD,
      y: 16,
      z: 0,
      text: chart.unit,
      anchor: "start",
      tone: "accent",
      size: "sm",
      bold: true,
    });

  // X labels, thinned to what fits.
  const widest = Math.max(...labels.map((l) => textWidth(l, "xs")), 10);
  const every = Math.max(1, Math.ceil((widest + 22) / slot));
  labels.forEach((label, i) => {
    if ((n - 1 - i) % every !== 0) return;
    out.labels.push({
      id: `x:${i}`,
      x: left + (i + 0.5) * slot,
      y: bottom + 17,
      z: 0,
      text: label,
      anchor: "middle",
      tone: i === n - 1 ? "accent" : "dim",
      size: "xs",
      bold: i === n - 1,
    });
  });

  chart.series.forEach((series, s) => {
    const base: Tone = SERIES_TONES[s % SERIES_TONES.length]!;
    const at = (label: string) => series.points.find((p) => p.label === label);
    const unitText = (v: number) =>
      `${num(v)}${chart.unit === "%" ? "%" : ` ${chart.unit}`}`;
    if (chart.type === "bar") {
      labels.forEach((label, i) => {
        const point = at(label);
        const x0 =
          left +
          (i + 0.5) * slot -
          groupW / 2 +
          s * (barW + (count > 1 ? 2 : 0));
        if (!point || point.value === null) {
          out.shapes.push({
            id: `bar:${s}:${i}`,
            type: "box",
            tone: "unknown",
            style: "dashed",
            tip: `${series.label} · ${label}: onbekend`,
            x: x0,
            y: bottom - 5,
            w: barW,
            h: 5,
            d: 6,
            z: 0,
            appear: 0.2,
          });
          return;
        }
        const top = yOf(Math.max(point.value, scale.min));
        const h = Math.max(2, bottom - top);
        const latest = i === n - 1;
        out.shapes.push({
          id: `bar:${s}:${i}`,
          type: "box",
          tone: point.status ? toneOf(point.status) : base,
          style: "solid",
          tip: `${series.label} · ${label}: ${unitText(point.value)}`,
          x: x0,
          y: bottom - h,
          w: barW,
          h,
          d: latest ? 26 : 16,
          z: 0,
          appear: 0.1 + (i / n) * 0.6,
        });
        if (latest || point.value === dataMax)
          out.labels.push({
            id: `val:${s}:${i}`,
            x: x0 + barW / 2,
            y: bottom - h - 7,
            z: latest ? 26 : 16,
            text: num(point.value),
            anchor: "middle",
            tone: latest ? "text" : "dim",
            size: "xs",
            bold: latest,
          });
      });
    } else {
      const pts: [number, number][] = [];
      labels.forEach((label, i) => {
        const point = at(label);
        if (point && point.value !== null)
          pts.push([left + (i + 0.5) * slot, yOf(point.value)]);
      });
      if (pts.length > 1) {
        const z = s * 22;
        if (chart.type === "area")
          out.shapes.push({
            id: `area:${s}`,
            type: "area",
            tone: base,
            style: "solid",
            tip: `${series.label}: ${unitText(all.length ? Math.max(...series.points.map((p) => p.value ?? -Infinity)) : 0)} hoogste`,
            pts,
            baseY: bottom,
            d: 14,
            z,
            appear: 0.2,
          });
        out.lines.push({
          id: `line:${s}`,
          kind: "curve",
          pts,
          z: z + 14,
          tone: base,
          width: 2.5,
        });
        const last = pts[pts.length - 1]!;
        const lastValue = series.points.at(-1)?.value;
        if (lastValue !== null && lastValue !== undefined)
          out.labels.push({
            id: `val:${s}`,
            x: last[0],
            y: last[1] - 9,
            z: z + 14,
            text: num(lastValue),
            anchor: "middle",
            tone: "text",
            size: "xs",
            bold: true,
          });
      }
      // Hover targets for line/area: a thin box per point.
      labels.forEach((label, i) => {
        const point = at(label);
        if (!point || point.value === null) return;
        out.shapes.push({
          id: `pt:${s}:${i}`,
          type: "box",
          tone: base,
          style: "ghost",
          tip: `${series.label} · ${label}: ${unitText(point.value)}`,
          x: left + (i + 0.5) * slot - Math.min(slot, 14) / 2,
          y: yOf(point.value) - 3,
          w: Math.min(slot, 14),
          h: 6,
          d: 4,
          z: s * 22 + 8,
          appear: 0.5,
        });
      });
    }
  });

  out.height = bottom + 30;
  out.legend =
    chart.series.length > 1
      ? chart.series.map((series, s) => ({
          tone: SERIES_TONES[s % SERIES_TONES.length]!,
          label: series.label,
        }))
      : [];
  return finish(out);
}

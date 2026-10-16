import type { VizGauge, VizScene } from "../types.ts";
import { STATUS_LABELS } from "../colors.ts";
import { emptyLayout, type CardLayout } from "./types.ts";
import { PAD, finish, fit, markFor, num, toneOf } from "./common.ts";

const START = (135 * Math.PI) / 180;
const SWEEP = (270 * Math.PI) / 180;

export const gaugeFraction = (gauge: VizGauge): number | null => {
  if (gauge.value === null) return null;
  const min = gauge.min ?? 0;
  return Math.min(1, Math.max(0, (gauge.value - min) / (gauge.max - min)));
};

const valueText = (gauge: VizGauge): string =>
  gauge.value === null ? "–" : num(gauge.value);

/** Rings with a value, a unit, threshold ticks and the status in words. Unknown stays a dashed track. */
export function layoutGauges(scene: VizScene, width: number): CardLayout {
  const gauges = scene.gauges ?? [];
  const out = emptyLayout(width, 100);
  const inner = width - 2 * PAD;
  const cols = Math.max(1, Math.min(4, Math.floor(inner / 148), gauges.length));
  const cell = inner / cols;
  const radius = Math.min(58, cell / 2 - 14);
  const cellH = radius * 2 + 82;
  gauges.forEach((gauge, i) => {
    const col = i % cols;
    const row = Math.floor(i / cols);
    const cx = PAD + (col + 0.5) * cell;
    const top = 8 + row * cellH;
    const cy = top + radius + 6;
    const r1 = radius;
    const r0 = radius - 13;
    const fraction = gaugeFraction(gauge);
    const status = gauge.status;
    const word = STATUS_LABELS[status];
    const tip =
      gauge.value === null
        ? `${gauge.label}: onbekend`
        : `${gauge.label}: ${num(gauge.value)} ${gauge.unit} van ${num(gauge.max)} ${gauge.unit} (${word})`;
    out.shapes.push({
      id: `track:${gauge.id}`,
      type: "arc",
      tone: fraction === null ? "unknown" : "muted",
      style: fraction === null ? "dashed" : "ghost",
      tip,
      cx,
      cy,
      r0,
      r1,
      a0: START,
      a1: START + SWEEP,
      d: 6,
      z: -2,
      appear: 0,
    });
    if (fraction !== null && fraction > 0.004)
      out.shapes.push({
        id: `value:${gauge.id}`,
        type: "arc",
        tone: toneOf(status),
        style: "solid",
        tip,
        cx,
        cy,
        r0,
        r1,
        a0: START,
        a1: START + SWEEP * fraction,
        d: 16,
        z: 0,
        appear: 0.15 + (i / Math.max(1, gauges.length)) * 0.4,
      });
    // Threshold ticks.
    for (const [name, at] of [
      ["warn", gauge.warnAt],
      ["crit", gauge.critAt],
    ] as const) {
      if (at === undefined) continue;
      const f = Math.min(
        1,
        Math.max(0, (at - (gauge.min ?? 0)) / (gauge.max - (gauge.min ?? 0))),
      );
      const a = START + SWEEP * f;
      out.lines.push({
        id: `tick:${gauge.id}:${name}`,
        kind: "marker",
        pts: [
          [cx + Math.cos(a) * (r0 - 4), cy + Math.sin(a) * (r0 - 4)],
          [cx + Math.cos(a) * (r1 + 4), cy + Math.sin(a) * (r1 + 4)],
        ],
        z: 18,
        tone: name === "crit" ? "critical" : "warning",
        width: 1.5,
      });
    }
    out.labels.push({
      id: `v:${gauge.id}`,
      x: cx,
      y: cy + 8,
      z: 18,
      text: valueText(gauge),
      anchor: "middle",
      tone: gauge.value === null ? "dim" : "text",
      size: "xl",
      bold: true,
    });
    if (gauge.value !== null && gauge.unit)
      out.labels.push({
        id: `u:${gauge.id}`,
        x: cx,
        y: cy + 26,
        z: 18,
        text: gauge.unit,
        anchor: "middle",
        tone: "dim",
        size: "xs",
      });
    const below = cy + r1 * 0.72 + 22;
    out.labels.push({
      id: `l:${gauge.id}`,
      x: cx,
      y: below,
      z: 0,
      text: fit(gauge.label, cell - 8, "md", true),
      anchor: "middle",
      tone: "text",
      size: "md",
      bold: true,
    });
    const statusWord =
      gauge.value === null && status === "unknown" ? "Onbekend" : word;
    out.glyphs.push({
      id: `m:${gauge.id}`,
      x: cx - (statusWord.length * 3.4 + 8),
      y: below + 14,
      z: 0,
      size: 14,
      glyph: markFor(status),
      tone: toneOf(status),
      title: statusWord,
    });
    out.labels.push({
      id: `s:${gauge.id}`,
      x: cx + 7,
      y: below + 19,
      z: 0,
      text: statusWord,
      anchor: "middle",
      tone: toneOf(status),
      size: "sm",
      bold: true,
    });
    if (gauge.detail)
      out.labels.push({
        id: `d:${gauge.id}`,
        x: cx,
        y: below + 36,
        z: 0,
        text: fit(gauge.detail, cell - 8, "xs"),
        anchor: "middle",
        tone: "dim",
        size: "xs",
      });
  });
  const rows = Math.ceil(gauges.length / cols);
  out.height = 8 + rows * cellH - (gauges.some((g) => g.detail) ? 0 : 14);
  out.legend = (
    [
      { tone: "ok", label: "In orde" },
      { tone: "warning", label: "Let op" },
      { tone: "critical", label: "Probleem" },
    ] as const
  ).filter(() =>
    gauges.some((g) => g.warnAt !== undefined || g.critAt !== undefined),
  );
  return finish(out);
}

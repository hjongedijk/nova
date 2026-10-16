import { describe, expect, it } from "vitest";
import { ALL as FIXTURES } from "../../../../../../scripts/holo-card-fixtures.mjs";
import { sceneTables } from "../table.ts";
import type { VizScene } from "../types.ts";
import { parseInlineScene } from "./guard.ts";
import { layoutCard } from "./index.ts";
import { arcPath } from "./paths.ts";
import { claim3d, flatReason, release3d } from "./power.ts";
import { FONT_PX } from "./types.ts";

const fixtures = FIXTURES as Record<string, () => VizScene>;
const hints = { reducedMotion: false, saveData: false, webgl: true };

describe("card layout", () => {
  for (const [name, make] of Object.entries(fixtures))
    for (const width of [320, 390, 640, 900]) {
      it(`${name} at ${width}px: finite, inside the card, legible`, () => {
        const layout = layoutCard(make(), width);
        expect(layout.width).toBe(width);
        expect(layout.height).toBeGreaterThan(60);
        for (const label of layout.labels) {
          expect(Number.isFinite(label.x) && Number.isFinite(label.y)).toBe(
            true,
          );
          expect(FONT_PX[label.size]).toBeGreaterThanOrEqual(11);
          expect(label.text.length).toBeGreaterThan(0);
          const half =
            label.anchor === "middle"
              ? (label.text.length * FONT_PX[label.size] * 0.5) / 2
              : 0;
          expect(label.x + half).toBeLessThanOrEqual(width + 2);
          expect(label.x - half).toBeGreaterThanOrEqual(-2);
          expect(label.y).toBeLessThanOrEqual(layout.height + 4);
        }
        for (const shape of layout.shapes) {
          expect(shape.tip.length).toBeGreaterThan(0);
          if (shape.type === "box") {
            expect(
              [shape.x, shape.y, shape.w, shape.h].every(Number.isFinite),
            ).toBe(true);
            expect(shape.x).toBeGreaterThanOrEqual(-1);
            expect(shape.x + shape.w).toBeLessThanOrEqual(width + 1);
          }
        }
        const ids = [
          ...layout.shapes,
          ...layout.labels,
          ...layout.glyphs,
          ...layout.lines,
        ].map((item) => item.id);
        expect(new Set(ids).size).toBe(ids.length);
      });
    }

  it("is deterministic", () => {
    expect(layoutCard(fixtures.weather!(), 480)).toEqual(
      layoutCard(fixtures.weather!(), 480),
    );
  });

  it("draws unknown gauges dashed and writes the status in words", () => {
    const layout = layoutCard(fixtures.gauges!(), 640);
    const unknown = layout.shapes.find((s) => s.id === "track:temp")!;
    expect(unknown.style).toBe("dashed");
    expect(layout.shapes.some((s) => s.id === "value:temp")).toBe(false);
    const words = layout.labels.map((l) => l.text);
    expect(words).toEqual(
      expect.arrayContaining(["Onbekend", "Probleem", "Let op", "In orde"]),
    );
  });

  it("puts the now marker inside the timeline and dims past events", () => {
    const layout = layoutCard(fixtures.timeline!(), 640);
    expect(layout.lines.some((l) => l.id === "now-line")).toBe(true);
    expect(layout.labels.find((l) => l.id === "now-label")!.text).toBe(
      "Nu 14:32",
    );
    expect(layout.shapes.find((s) => s.id === "item:e1")!.style).toBe("ghost");
    expect(layout.shapes.find((s) => s.id === "item:e4")!.style).toBe("solid");
  });

  it("states the tile status as a word and a mark, not only a colour", () => {
    const scene = fixtures.tiles!();
    const layout = layoutCard(scene, 400);
    for (const tile of scene.tiles!) {
      expect(layout.labels.some((l) => l.id === `s:${tile.id}`)).toBe(true);
      expect(layout.glyphs.some((g) => g.id === `m:${tile.id}`)).toBe(true);
    }
  });

  it("leaves a gap for an unknown series point instead of a bar", () => {
    const layout = layoutCard(fixtures.series!(), 640);
    const gap = layout.shapes.find((s) => s.id === "bar:0:14")!;
    expect(gap.style).toBe("dashed");
    expect(gap.tip).toContain("onbekend");
  });
});

describe("accessible text version", () => {
  for (const [name, make] of Object.entries(fixtures))
    it(`${name} has a table and a summary`, () => {
      const scene = make();
      expect(scene.summary!.length).toBeGreaterThan(10);
      const tables = sceneTables(scene);
      expect(tables.length).toBeGreaterThan(0);
      expect(tables.every((t) => t.rows.length > 0)).toBe(true);
    });
});

describe("inline scene guard", () => {
  it("accepts the fixtures and refuses malformed network data", () => {
    for (const make of Object.values(fixtures))
      expect(parseInlineScene(make())).not.toBeNull();
    expect(parseInlineScene(null)).toBeNull();
    expect(
      parseInlineScene({ ...fixtures.weather!(), kind: "graph" }),
    ).toBeNull();
    expect(
      parseInlineScene({
        ...fixtures.weather!(),
        weather: { hours: "x", days: [] },
      }),
    ).toBeNull();
    expect(
      parseInlineScene({
        ...fixtures.gauges!(),
        gauges: [{ id: "a", max: 0, status: "ok" }],
      }),
    ).toBeNull();
    expect(
      parseInlineScene({
        ...fixtures.timeline!(),
        timeline: { start: "x", end: "y", now: "z", items: [] },
      }),
    ).toBeNull();
    const huge = fixtures.tiles!();
    huge.tiles![0]!.label = "x".repeat(70_000);
    expect(parseInlineScene(huge)).toBeNull();
  });
});

describe("flat fallback decision", () => {
  it("stays flat for reduced motion, low power and no WebGL", () => {
    expect(flatReason(hints)).toBeNull();
    expect(flatReason({ ...hints, reducedMotion: true })).toBe(
      "reduced-motion",
    );
    expect(flatReason({ ...hints, saveData: true })).toBe("low-power");
    expect(flatReason({ ...hints, memoryGb: 2 })).toBe("low-power");
    expect(flatReason({ ...hints, cores: 2 })).toBe("low-power");
    expect(
      flatReason({ ...hints, battery: { level: 0.1, charging: false } }),
    ).toBe("low-power");
    expect(
      flatReason({ ...hints, battery: { level: 0.1, charging: true } }),
    ).toBeNull();
    expect(flatReason({ ...hints, webgl: false })).toBe("no-webgl");
    // The WebGL probe makes a context: it is skipped when something else already decides.
    let probed = 0;
    const probe = () => (probed++, true);
    expect(flatReason({ ...hints, reducedMotion: true, webgl: probe })).toBe(
      "reduced-motion",
    );
    expect(flatReason({ ...hints, cores: 1, webgl: probe })).toBe("low-power");
    expect(probed).toBe(0);
    expect(flatReason({ ...hints, webgl: probe })).toBeNull();
    expect(probed).toBe(1);
  });
  it("limits simultaneous 3D cards", () => {
    expect(claim3d()).toBe(true);
    expect(claim3d()).toBe(true);
    expect(claim3d()).toBe(false);
    release3d();
    release3d();
    expect(claim3d()).toBe(true);
    release3d();
  });
});

describe("paths", () => {
  it("draws a ring segment", () => {
    const d = arcPath({
      id: "a",
      type: "arc",
      tone: "ok",
      style: "solid",
      tip: "t",
      d: 1,
      z: 0,
      appear: 0,
      cx: 50,
      cy: 50,
      r0: 30,
      r1: 40,
      a0: 0,
      a1: Math.PI,
    });
    expect(d).toMatch(/^M90 50A40 40 0 0 1 10 50L20 50A30 30 0 0 0 80 50Z$/);
  });
});

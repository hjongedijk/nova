import type { VizScene } from "@nova/contracts";
import { describe, expect, it } from "vitest";
import { validateScene } from "../../src/visualization/scene.validation.js";

const base = (over: Partial<VizScene>): VizScene => ({
  schema: 1,
  id: "viz-1",
  title: "T",
  kind: "gauges",
  providerId: "inline",
  typeId: "x",
  revision: 1,
  updatedAt: "2026-10-16T10:00:00.000Z",
  layers: [],
  modes: ["holographic"],
  defaultMode: "holographic",
  notes: [],
  actions: [],
  view: { highlights: [], annotations: [], hiddenLayers: [], rotations: [] },
  ...over,
});
const gauge = {
  id: "a",
  label: "CPU",
  value: 5,
  unit: "%",
  max: 100,
  status: "ok" as const,
};

describe("card scene validation", () => {
  it("accepts well-formed card scenes", () => {
    expect(validateScene(base({ gauges: [gauge] })).ok).toBe(true);
    expect(
      validateScene(
        base({
          kind: "tiles",
          tiles: [{ id: "t", label: "L", state: "Aan", status: "active" }],
        }),
      ).ok,
    ).toBe(true);
  });
  it("refuses an unknown value that claims to be healthy", () => {
    expect(
      validateScene(base({ gauges: [{ ...gauge, value: null }] })).ok,
    ).toBe(false);
    expect(
      validateScene(
        base({ gauges: [{ ...gauge, value: null, status: "unknown" }] }),
      ).ok,
    ).toBe(true);
  });
  it("refuses bad data: missing arrays, non-finite numbers, duplicates, unknown groups, bad dates", () => {
    expect(validateScene(base({ gauges: [] })).ok).toBe(false);
    expect(validateScene(base({ gauges: [{ ...gauge, max: 0 }] })).ok).toBe(
      false,
    );
    expect(validateScene(base({ gauges: [gauge, gauge] })).ok).toBe(false);
    expect(
      validateScene(
        base({
          kind: "tiles",
          tiles: [
            { id: "t", label: "L", state: "x", status: "ok", group: "nope" },
          ],
        }),
      ).ok,
    ).toBe(false);
    expect(validateScene(base({ kind: "weather" })).ok).toBe(false);
    expect(
      validateScene(
        base({
          kind: "weather",
          weather: {
            place: "P",
            hours: [
              {
                label: "1",
                temperature: Number.NaN,
                rainPercent: 0,
                condition: "x",
                glyph: "clear",
              },
            ],
            days: [],
          },
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateScene(
        base({
          kind: "timeline",
          timeline: {
            start: "x",
            end: "y",
            now: "z",
            timeZone: "UTC",
            items: [],
          },
        }),
      ).ok,
    ).toBe(false);
    expect(
      validateScene(
        base({
          kind: "series",
          chart: {
            type: "bar",
            unit: "kW",
            series: [{ label: "a", points: [{ label: "1", value: 1 }] }],
          },
        }),
      ).ok,
    ).toBe(false);
  });
  it("refuses nodes on a card scene and caps the size", () => {
    expect(
      validateScene(base({ gauges: [gauge], nodes: [{ id: "n", label: "n" }] }))
        .ok,
    ).toBe(false);
    const many = Array.from({ length: 121 }, (_, i) => ({
      id: `t${i}`,
      label: "L",
      state: "x",
      status: "ok" as const,
    }));
    expect(validateScene(base({ kind: "tiles", tiles: many })).ok).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import {
  checkCustomScad,
  DesignError,
  getTemplate,
  holeGrid,
  listTemplates,
  normalizeParams,
} from "../../src/fabrication/templates.js";

describe("templates", () => {
  it("offers the four templates with documented ranges", () => {
    expect(
      listTemplates()
        .map((t) => t.id)
        .sort(),
    ).toEqual(["enclosure", "headset_stand", "plate", "wall_bracket"]);
  });

  it("fills defaults, rejects unknown keys, ranges and non-numbers", () => {
    const t = getTemplate("wall_bracket");
    expect(normalizeParams(t, { width: 120 }).width).toBe(120);
    expect(normalizeParams(t, {}).holes).toBe(4);
    expect(() => normalizeParams(t, { colour: 1 })).toThrow(DesignError);
    expect(() => normalizeParams(t, { width: 5 })).toThrow(/tussen/);
    expect(() => normalizeParams(t, { width: "wide" })).toThrow(/getal/);
    expect(normalizeParams(t, { holes: 3.6 }).holes).toBe(4);
  });

  it("applies a change on top of the current parameters", () => {
    const t = getTemplate("wall_bracket");
    const base = normalizeParams(t, { width: 120, holes: 4 });
    const next = normalizeParams(t, { holeDiameter: 6 }, base);
    expect(next.width).toBe(120);
    expect(next.holeDiameter).toBe(6);
  });

  it("builds a 120 mm bracket with four holes and promises its outer size", () => {
    const t = getTemplate("wall_bracket");
    const built = t.build(
      normalizeParams(t, { width: 120, holes: 4, holeDiameter: 5 }),
    );
    expect(built.expected).toEqual([120, 50, 60]);
    expect(built.scad.match(/cylinder\(d=5,/g)).toHaveLength(4);
  });

  it("refuses holes that cannot fit and radii that swallow the part", () => {
    const t = getTemplate("wall_bracket");
    expect(() =>
      t.build(normalizeParams(t, { width: 20, holes: 8, holeDiameter: 12 })),
    ).toThrow(/passen niet/);
    expect(() =>
      getTemplate("plate").build(
        normalizeParams(getTemplate("plate"), {
          width: 10,
          depth: 10,
          cornerRadius: 6,
          holes: 0,
        }),
      ),
    ).toThrow(/hoekradius/);
    const stand = getTemplate("headset_stand");
    expect(() =>
      stand.build(normalizeParams(stand, { baseDepth: 60, armLength: 60 })),
    ).toThrow(/passen niet/);
  });

  it("puts the enclosure lid beside the box and counts it in the size", () => {
    const t = getTemplate("enclosure");
    const withLid = t.build(
      normalizeParams(t, {
        innerWidth: 60,
        innerDepth: 40,
        innerHeight: 25,
        wall: 2,
        lid: 1,
      }),
    );
    const without = t.build(
      normalizeParams(t, {
        innerWidth: 60,
        innerDepth: 40,
        innerHeight: 25,
        wall: 2,
        lid: 0,
      }),
    );
    expect(without.expected).toEqual([64, 44, 27]);
    expect(withLid.expected).toEqual([64 * 2 + 5, 44, 27]);
  });

  it("lays out hole grids inside the face", () => {
    for (const n of [1, 2, 3, 4, 5, 8])
      for (const [x, y] of holeGrid(n, 100, 60, 10)) {
        expect(x).toBeGreaterThanOrEqual(10);
        expect(x).toBeLessThanOrEqual(90);
        expect(y).toBeGreaterThanOrEqual(10);
        expect(y).toBeLessThanOrEqual(50);
      }
    expect(holeGrid(4, 100, 60, 10)).toHaveLength(4);
    expect(holeGrid(0, 100, 60, 10)).toEqual([]);
  });

  it("only accepts custom OpenSCAD that cannot reach for files", () => {
    expect(checkCustomScad("cube([1,2,3]);")).toContain("cube");
    for (const bad of [
      "include <x.scad>;",
      "use <x.scad>;",
      'import("/etc/passwd");',
      'surface(file="a.dat");',
      "",
      "x".repeat(70_000),
    ])
      expect(() => checkCustomScad(bad)).toThrow(DesignError);
  });
});

import { describe, expect, it } from "vitest";
import {
  analyzeMesh,
  MeshError,
  parseStl,
  printabilityIssues,
  repairMesh,
  writeBinaryStl,
} from "../../src/fabrication/mesh.js";
import { boxStl, boxTriangles } from "./fixtures.js";

const volume = { x: 256, y: 256, z: 256 };

describe("mesh analysis", () => {
  it("measures a closed box exactly", () => {
    const r = analyzeMesh(boxTriangles(20, 30, 40));
    expect(r.bounds.size).toEqual([20, 30, 40]);
    expect(r.watertight).toBe(true);
    expect(r.volumeMm3).toBeCloseTo(24000, 3);
    expect(r.surfaceAreaMm2).toBeCloseTo(2 * (600 + 800 + 1200), 3);
    expect(r.bedContactAreaMm2).toBeCloseTo(600, 3);
    expect(r.supportsLikely).toBe(false);
  });

  it("round-trips binary and parses ASCII STL", () => {
    const tri = boxTriangles(5, 6, 7);
    expect(Array.from(parseStl(writeBinaryStl(tri)))).toEqual(Array.from(tri));
    const ascii = `solid t\n${Array.from({ length: tri.length / 9 }, (_, i) => `facet normal 0 0 0\nouter loop\n${[0, 3, 6].map((k) => `vertex ${tri[i * 9 + k]} ${tri[i * 9 + k + 1]} ${tri[i * 9 + k + 2]}`).join("\n")}\nendloop\nendfacet`).join("\n")}\nendsolid t\n`;
    expect(analyzeMesh(parseStl(Buffer.from(ascii))).watertight).toBe(true);
  });

  it("rejects non-STL, truncated and non-finite input", () => {
    expect(() => parseStl(Buffer.from("hello"))).toThrow(MeshError);
    const bad = boxStl(1, 1, 1).subarray(0, 100);
    expect(() => parseStl(bad)).toThrow(MeshError);
    const nan = Buffer.from(boxStl(1, 1, 1));
    nan.writeFloatLE(Number.NaN, 84 + 12);
    expect(() => parseStl(nan)).toThrow(/ongeldige/);
  });

  it("finds a hole, a flipped face and degenerate or duplicate triangles", () => {
    const tri = boxTriangles(10, 10, 10);
    const hole = tri.slice(0, tri.length - 9);
    expect(analyzeMesh(hole).openEdges).toBeGreaterThan(0);
    expect(analyzeMesh(hole).watertight).toBe(false);

    const flipped = Float32Array.from(tri);
    for (let k = 0; k < 3; k++) {
      const a = flipped[k + 3]!;
      flipped[k + 3] = flipped[k + 6]!;
      flipped[k + 6] = a;
    }
    expect(analyzeMesh(flipped).nonManifoldEdges).toBeGreaterThan(0);

    const extra = new Float32Array(tri.length + 18);
    extra.set(tri);
    extra.set(tri.subarray(0, 9), tri.length); // duplicate
    extra.set([1, 1, 1, 1, 1, 1, 2, 2, 2], tri.length + 9); // degenerate
    const r = analyzeMesh(extra);
    expect(r.duplicateTriangles).toBe(1);
    expect(r.degenerateTriangles).toBe(1);
    expect(r.watertight).toBe(true);
  });

  it("repair removes junk, centres on x/y and drops onto the bed, but does not close holes", () => {
    const tri = boxTriangles(10, 10, 10, 100, 100, 50);
    const junk = new Float32Array(tri.length + 9);
    junk.set(tri);
    junk.set([1, 1, 1, 1, 1, 1, 2, 2, 2], tri.length);
    const fixed = repairMesh(junk);
    expect(fixed.removed).toBe(1);
    const r = analyzeMesh(fixed.triangles);
    expect(r.bounds.min[2]).toBeCloseTo(0, 5);
    expect((r.bounds.min[0] + r.bounds.max[0]) / 2).toBeCloseTo(0, 5);
    const withHole = repairMesh(tri.slice(0, tri.length - 9));
    expect(analyzeMesh(withHole.triangles).watertight).toBe(false);
  });

  it("detects overhangs that do not rest on the bed", () => {
    // a plate floating 10 mm above the bed with a big plate below makes the underside an overhang
    const base = boxTriangles(5, 5, 5);
    const shelf = boxTriangles(40, 40, 2, -10, -10, 10);
    const both = new Float32Array(base.length + shelf.length);
    both.set(base);
    both.set(shelf, base.length);
    const r = analyzeMesh(both);
    expect(r.overhangAreaMm2).toBeGreaterThan(1000);
    expect(r.supportsLikely).toBe(true);
  });
});

describe("printability findings", () => {
  it("flags a part that does not fit the P2S bed and says so in millimetres", () => {
    const issues = printabilityIssues(
      analyzeMesh(boxTriangles(300, 20, 20)),
      volume,
    );
    expect(issues.find((i) => i.code === "build_volume")?.level).toBe("error");
    expect(issues.find((i) => i.code === "build_volume")?.message).toContain(
      "300.0",
    );
  });

  it("reports an open mesh as an error and always states the limits of the check", () => {
    const tri = boxTriangles(20, 20, 20);
    const issues = printabilityIssues(
      analyzeMesh(tri.slice(0, tri.length - 9)),
      volume,
    );
    expect(
      issues.some((i) => i.code === "not_watertight" && i.level === "error"),
    ).toBe(true);
    expect(issues.at(-1)?.message).toMatch(/geen sterkte|garandeert geen/i);
  });

  it("has no errors for a clean box", () => {
    expect(
      printabilityIssues(analyzeMesh(boxTriangles(30, 30, 30)), volume).filter(
        (i) => i.level === "error",
      ),
    ).toEqual([]);
  });
});

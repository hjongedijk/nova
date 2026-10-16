import { describe, expect, it } from "vitest";
import { heatColor, resolveTheme, shapeOf, statusColor } from "./colors.ts";
import { layoutGraph } from "./layout.ts";
import { distance, formatDistance } from "./measure.ts";
import { availableModes, resolveMode } from "./modes.ts";
import { sceneSignature, sceneTables } from "./table.ts";
import type { VizScene } from "./types.ts";
import { assertSafeUrl } from "./loaders.ts";

const scene = (over: Partial<VizScene> = {}): VizScene => ({
  schema: 1,
  id: "viz-1",
  title: "Test",
  kind: "graph",
  providerId: "custom",
  typeId: "graph",
  revision: 1,
  updatedAt: "2026-10-16T10:00:00.000Z",
  nodes: [
    { id: "root", label: "Root", status: "ok", layer: "a" },
    {
      id: "k1",
      label: "Kind 1",
      parent: "root",
      status: "unknown",
      layer: "b",
    },
    { id: "k2", label: "Kind 2", parent: "root", value: 0.5, layer: "b" },
    { id: "g1", label: "Klein", parent: "k1" },
  ],
  edges: [{ from: "root", to: "k1", label: "bevat" }],
  layers: [
    { id: "a", label: "A" },
    { id: "b", label: "B" },
  ],
  modes: ["holographic", "realistic", "wireframe", "heatmap", "xray"],
  defaultMode: "holographic",
  notes: ["let op"],
  actions: [],
  view: { highlights: [], annotations: [], hiddenLayers: [], rotations: [] },
  ...over,
});

describe("layout", () => {
  it("is deterministic and puts the single root in the centre", () => {
    const a = layoutGraph(scene());
    const b = layoutGraph(scene());
    expect([...a.places]).toEqual([...b.places]);
    expect(a.places.get("root")).toMatchObject({ u: 0, v: 0, depth: 0 });
    expect(a.places.get("k1")!.depth).toBe(1);
    expect(a.places.get("g1")!.depth).toBe(2);
  });

  it("keeps nodes apart and lifts layers in 3D", () => {
    const { places } = layoutGraph(scene());
    const k1 = places.get("k1")!;
    const k2 = places.get("k2")!;
    expect(Math.hypot(k1.u - k2.u, k1.v - k2.v)).toBeGreaterThan(2);
    expect(places.get("root")!.h).toBeLessThan(places.get("k1")!.h);
  });

  it("scales the rings with many children so they do not overlap", () => {
    const nodes = [
      { id: "r", label: "r" },
      ...Array.from({ length: 60 }, (_, i) => ({
        id: `n${i}`,
        label: "n",
        parent: "r",
      })),
    ];
    const { places } = layoutGraph({ nodes, layers: [] });
    const pts = [...places.values()].filter((p) => p.depth === 1);
    let min = Infinity;
    for (let i = 0; i < pts.length; i++)
      for (let j = i + 1; j < pts.length; j++)
        min = Math.min(
          min,
          Math.hypot(pts[i]!.u - pts[j]!.u, pts[i]!.v - pts[j]!.v),
        );
    expect(min).toBeGreaterThan(2);
  });

  it("keeps real positions and never invents any for them", () => {
    const { places } = layoutGraph(
      scene({
        nodes: [{ id: "a", label: "A", position: [4, 5, 6] }],
        edges: [],
      }),
    );
    expect(places.get("a")).toMatchObject({ u: 4, v: 5, h: 6 });
  });

  it("survives cycles and empty graphs", () => {
    expect(layoutGraph({ nodes: [], layers: [] }).places.size).toBe(0);
    const cyc = layoutGraph({
      nodes: [
        { id: "a", label: "a", parent: "b" },
        { id: "b", label: "b", parent: "a" },
      ],
      layers: [],
    });
    expect(cyc.radius).toBeGreaterThan(0);
  });
});

describe("modes", () => {
  it("offers only modes that fit the content", () => {
    const withValues = scene();
    expect(availableModes(withValues)).toEqual([
      "holographic",
      "realistic",
      "wireframe",
      "heatmap",
    ]);
    const noValues = scene({ nodes: [{ id: "a", label: "A" }], edges: [] });
    expect(availableModes(noValues)).not.toContain("heatmap");
    expect(availableModes(noValues)).not.toContain("xray");
    expect(availableModes(scene({ kind: "chart" }))).toEqual([]);
    expect(
      availableModes(
        scene({
          kind: "model",
          nodes: undefined,
          modes: ["xray", "technical", "heatmap"],
        }),
      ),
    ).toEqual(["xray", "technical"]);
  });

  it("falls back to the scene default for a mode that does not fit", () => {
    expect(resolveMode(scene(), "xray")).toBe("holographic");
    expect(resolveMode(scene(), "wireframe")).toBe("wireframe");
    expect(resolveMode(scene(), null)).toBe("holographic");
  });
});

describe("table fallback", () => {
  it("lists every node and says unknown for unknown", () => {
    const [nodes, edges] = sceneTables(scene());
    expect(nodes!.rows).toHaveLength(4);
    const unknown = nodes!.rows.find((r) => r.id === "k1")!;
    expect(unknown.cells[2]).toBe("Onbekend");
    expect(unknown.cells[3]).toBe("onbekend");
    expect(unknown.cells[4]).toBe("Root");
    expect(edges!.rows[0]!.cells).toEqual(["Root", "Kind 1", "bevat"]);
  });

  it("tables charts and models", () => {
    const chart = sceneTables(
      scene({
        kind: "chart",
        nodes: undefined,
        chart: {
          type: "bar",
          unit: "%",
          series: [
            {
              label: "CPU",
              points: [
                { label: "a", value: null },
                { label: "b", value: 4, status: "ok" },
              ],
            },
          ],
        },
      }),
    )[0]!;
    expect(chart.rows.map((r) => r.cells)).toEqual([
      ["CPU", "a", "onbekend", "Onbekend"],
      ["CPU", "b", "4 %", "In orde"],
    ]);
    const model = sceneTables(
      scene({
        kind: "model",
        nodes: undefined,
        models: [
          { id: "m", label: "Beugel", format: "stl", url: "/api/x.stl" },
        ],
        hotspots: [{ id: "h", label: "Gat", position: [1, 2, 3.456] }],
      }),
    );
    expect(model[0]!.rows[0]!.cells).toEqual(["Beugel", "STL", "–"]);
    expect(model[1]!.rows[0]!.cells[1]).toBe("1, 2, 3.46");
  });

  it("signature ignores view state but not data", () => {
    const a = scene();
    const b = scene({ revision: 2, view: { ...a.view, highlights: ["root"] } });
    expect(sceneSignature(a)).toBe(sceneSignature(b));
    expect(sceneSignature(a)).not.toBe(
      sceneSignature(scene({ nodes: [{ id: "x", label: "X" }], edges: [] })),
    );
  });
});

describe("colours, shapes, measuring, urls", () => {
  it("unknown has its own neutral colour and heat of null is grey", () => {
    expect(statusColor("unknown", "dark")).not.toBe(statusColor("ok", "dark"));
    expect(statusColor(undefined, "dark")).toBe(statusColor("unknown", "dark"));
    expect(heatColor(null)).toBe("#55536f");
    expect(heatColor(0)).toBe("#2b6cff");
    expect(heatColor(1)).toBe("#ff5b3a");
    expect(heatColor(7)).toBe("#ff5b3a");
  });
  it("themes and shapes", () => {
    expect(resolveTheme("auto", true)).toBe("light");
    expect(resolveTheme("dark", true)).toBe("dark");
    expect(shapeOf("storage")).toBe("cylinder");
    expect(shapeOf("lxc")).not.toBe(shapeOf("vm"));
    expect(shapeOf(undefined)).toBe("sphere");
  });
  it("measures", () => {
    expect(distance([0, 0, 0], [3, 4, 0])).toBe(5);
    expect(formatDistance(12.345, "mm")).toBe("12,35 mm");
    expect(formatDistance(1, "")).toBe("1 eenheden");
  });
  it("only same-origin model urls load", () => {
    expect(() => assertSafeUrl("/api/print/1.stl")).not.toThrow();
    expect(() => assertSafeUrl("blob:https://x/abc")).not.toThrow();
    expect(() => assertSafeUrl("https://evil.example/x.stl")).toThrow();
    expect(() => assertSafeUrl("//evil.example/x.stl")).toThrow();
  });
});

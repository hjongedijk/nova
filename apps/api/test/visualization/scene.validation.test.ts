import { describe, expect, it } from "vitest";
import type { VizScene } from "@nova/contracts";
import {
  isSafeModelUrl,
  modesFor,
  validateScene,
} from "../../src/visualization/scene.validation.js";

const base = (over: Partial<VizScene> = {}): VizScene => ({
  schema: 1,
  id: "viz-0123456789",
  title: "Test",
  kind: "graph",
  providerId: "custom",
  typeId: "graph",
  revision: 1,
  updatedAt: new Date().toISOString(),
  nodes: [
    { id: "a", label: "A" },
    { id: "b", label: "B", parent: "a", status: "ok", value: 0.5 },
  ],
  edges: [{ from: "a", to: "b" }],
  layers: [],
  modes: ["holographic", "realistic"],
  defaultMode: "holographic",
  notes: [],
  actions: [],
  view: { highlights: [], annotations: [], hiddenLayers: [], rotations: [] },
  ...over,
});

describe("scene validation", () => {
  it("accepts a well-formed graph", () => {
    expect(validateScene(base())).toEqual({ ok: true, errors: [] });
  });

  it.each([
    [
      "duplicate ids",
      {
        nodes: [
          { id: "a", label: "A" },
          { id: "a", label: "B" },
        ],
      },
      "dubbele node-id",
    ],
    [
      "edge to unknown node",
      { edges: [{ from: "a", to: "zzz" }] },
      "onbekende node",
    ],
    [
      "unknown parent",
      { nodes: [{ id: "a", label: "A", parent: "x" }] },
      "onbekende parent",
    ],
    [
      "value out of range",
      { nodes: [{ id: "a", label: "A", value: 1.5 }] },
      "tussen 0 en 1",
    ],
    [
      "non-finite position",
      { nodes: [{ id: "a", label: "A", position: [0, NaN, 0] as never }] },
      "ongeldige positie",
    ],
    [
      "unknown status",
      { nodes: [{ id: "a", label: "A", status: "great" as never }] },
      "onbekende status",
    ],
    [
      "parent cycle",
      {
        nodes: [
          { id: "a", label: "A", parent: "b" },
          { id: "b", label: "B", parent: "a" },
        ],
        edges: [],
      },
      "parent-lus",
    ],
    ["mode outside modes", { defaultMode: "xray" as never }, "defaultMode"],
  ] as [string, Partial<VizScene>, string][])(
    "rejects %s",
    (_name, patch, message) => {
      const result = validateScene(base(patch));
      expect(result.ok).toBe(false);
      expect(result.errors.join(" ")).toContain(message);
    },
  );

  it("bounds the number of nodes", () => {
    const nodes = Array.from({ length: 1501 }, (_, i) => ({
      id: `n${i}`,
      label: "x",
    }));
    expect(validateScene(base({ nodes, edges: [] })).errors.join()).toContain(
      "maximaal 1500",
    );
  });

  it("validates models: format and same-origin urls only", () => {
    const model = (url: string, format = "glb") =>
      base({
        kind: "model",
        nodes: undefined,
        edges: undefined,
        models: [{ id: "m", label: "M", format: format as never, url }],
      });
    expect(validateScene(model("/api/print/jobs/1/model.glb")).ok).toBe(true);
    expect(validateScene(model("blob:https://nova.local/abc-123")).ok).toBe(
      true,
    );
    expect(validateScene(model("https://evil.example/x.glb")).ok).toBe(false);
    expect(validateScene(model("//evil.example/x.glb")).ok).toBe(false);
    expect(validateScene(model("/api/../etc/passwd")).ok).toBe(false);
    expect(validateScene(model("/api/x.obj", "obj")).ok).toBe(false);
  });

  it("validates charts", () => {
    const chart = base({
      kind: "chart",
      nodes: undefined,
      edges: undefined,
      modes: ["realistic"],
      defaultMode: "realistic",
      chart: {
        type: "bar",
        unit: "%",
        series: [{ label: "CPU", points: [{ label: "a", value: null }] }],
      },
    });
    expect(validateScene(chart).ok).toBe(true);
    expect(
      validateScene({ ...chart, chart: { type: "bar", unit: "%", series: [] } })
        .ok,
    ).toBe(false);
  });

  it("only offers modes that fit the content", () => {
    expect(modesFor({ kind: "chart" })).toEqual(["realistic"]);
    expect(modesFor({ kind: "graph", nodes: [{}] })).not.toContain("heatmap");
    expect(modesFor({ kind: "graph", nodes: [{ value: 0.2 }] })).toContain(
      "heatmap",
    );
    expect(modesFor({ kind: "graph", nodes: [] })).not.toContain("xray");
    expect(modesFor({ kind: "model" })).toEqual(
      expect.arrayContaining(["technical", "xray"]),
    );
  });

  it("isSafeModelUrl rejects control characters and backslashes", () => {
    expect(isSafeModelUrl("/api/a\\b")).toBe(false);
    expect(isSafeModelUrl("/api/a\nb")).toBe(false);
    expect(isSafeModelUrl("javascript:alert(1)")).toBe(false);
    expect(isSafeModelUrl("data:text/plain,hi")).toBe(false);
  });
});

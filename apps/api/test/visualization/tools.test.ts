import { Module } from "@nestjs/common";
import { Test } from "@nestjs/testing";
import { beforeAll, describe, expect, it } from "vitest";
import { CoreModule } from "../../src/core/core.module.js";
import { ToolsModule } from "../../src/tools/tools.module.js";
import { ToolsService } from "../../src/tools/tools.service.js";
import {
  isDisplayRequest,
  resolveTopic,
} from "../../src/visualization/intent.js";
import {
  proxmoxTopology,
  type ProxmoxSnapshot,
} from "../../src/visualization/providers/proxmox.provider.js";
import { VisualizationRegistry } from "../../src/visualization/visualization.registry.js";
import { VisualizationService } from "../../src/visualization/visualization.service.js";
import { VisualizationSource } from "../../src/visualization/visualization.source.js";
import type { VisualizationProvider } from "../../src/visualization/visualization.types.js";

const GB = 1073741824;
let failing = false;
let builds = 0;
const snapshot: ProxmoxSnapshot = {
  nodes: [
    {
      node: "pve",
      status: "online",
      cpu: 0.3,
      cores: 4,
      memUsed: GB,
      memTotal: 4 * GB,
      uptime: 5000,
    },
  ],
  guests: [
    {
      vmid: 104,
      name: "web",
      node: "pve",
      type: "qemu",
      label: "QEMU VM",
      status: "running",
      cpuUsagePercent: 10,
      memoryUsed: GB,
      memoryTotal: 2 * GB,
      uptime: 10,
    },
  ],
  storage: [],
};

const fakeProxmox: VisualizationProvider = {
  id: "proxmox",
  label: "Proxmox",
  requires: { service: "proxmox", access: "read-only" },
  types: [
    {
      id: "topology",
      title: "Topologie",
      kind: "graph",
      description: "x",
      keywords: ["proxmox", "server", "servers", "vm"],
    },
  ],
  available: () => ({ ok: true }),
  async build() {
    builds++;
    if (failing) throw new Error("secret-host.internal refused");
    return { ...proxmoxTopology(snapshot), refreshMs: 5000 };
  },
};
const fakeNetwork: VisualizationProvider = {
  id: "network",
  label: "Netwerk",
  requires: { service: "checks", access: "read-only" },
  types: [
    {
      id: "overview",
      title: "Netwerk",
      kind: "graph",
      description: "x",
      keywords: ["netwerk", "internet"],
    },
  ],
  available: () => ({ ok: false, reason: "Geen controles ingesteld." }),
  async build() {
    throw new Error("unreachable");
  },
};

@Module({
  providers: [VisualizationRegistry, VisualizationService, VisualizationSource],
  exports: [VisualizationRegistry, VisualizationService],
})
class VizTestModule {}

describe("visualization tools through the real tool registry", () => {
  let tools: ToolsService;
  let service: VisualizationService;
  const run = (name: string, args: Record<string, unknown> = {}) =>
    tools.execute(name, args, "viz-session", null, false, {
      signal: new AbortController().signal,
    });

  beforeAll(async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [CoreModule, ToolsModule, VizTestModule],
    }).compile();
    const registry = moduleRef.get(VisualizationRegistry);
    registry.register(fakeProxmox);
    registry.register(fakeNetwork);
    await moduleRef.init();
    tools = moduleRef.get(ToolsService);
    service = moduleRef.get(VisualizationService);
  });

  it("registers exactly the specified tools, all READ_ONLY (screen state only)", () => {
    const list = tools.list().filter((tool) => tool.source === "visualization");
    expect(list.map((tool) => tool.name).sort()).toEqual(
      [
        "annotate_object",
        "clear_visualization",
        "create_visualization",
        "export_visualization",
        "focus_camera",
        "highlight_object",
        "load_3d_scene",
        "rotate_object",
        "show_object_details",
        "update_visualization",
      ].sort(),
    );
    expect(list.every((tool) => tool.risk === "READ_ONLY")).toBe(true);
    expect(list.every((tool) => tool.enabled)).toBe(true);
  });

  it("create_visualization opens a scene and returns the event for the screen", async () => {
    const result = await run("create_visualization", {
      source: "toon mijn proxmox",
    });
    expect(result.ok).toBe(true);
    expect(result.visualization).toMatchObject({
      action: "open",
      kind: "graph",
    });
    expect((result.result as { nodes: number }).nodes).toBeGreaterThanOrEqual(
      3,
    );
    // The model/audit answer carries counts, not the whole scene.
    expect(JSON.stringify(result)).not.toContain("draait op");
  });

  it("rejects bad arguments before the source runs (schema)", async () => {
    expect((await run("create_visualization", {})).ok).toBe(false);
    expect(
      (await run("rotate_object", { object: "a", axis: "w", degrees: 10 })).ok,
    ).toBe(false);
    expect(
      (await run("rotate_object", { object: "a", axis: "x", degrees: 4000 }))
        .ok,
    ).toBe(false);
  });

  it("answers unknown sources and unavailable providers honestly", async () => {
    const unknown = await run("create_visualization", { source: "koelkast" });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("Kies uit");
    const unavailable = await run("create_visualization", {
      source: "network",
    });
    expect(unavailable).toMatchObject({
      ok: false,
      error: "Geen controles ingesteld.",
    });
  });

  it("does not leak provider errors to the model", async () => {
    failing = true;
    const result = await run("create_visualization", { source: "proxmox" });
    failing = false;
    expect(result.ok).toBe(false);
    expect(JSON.stringify(result)).not.toContain("secret-host");
  });

  it("highlight, annotate, focus, rotate and details act on real objects only", async () => {
    const created = await run("create_visualization", { source: "proxmox" });
    const id = (created.result as { id: string }).id;
    expect(
      (await run("highlight_object", { id, objects: ["guest:104"] })).ok,
    ).toBe(true);
    expect(service.get(id)!.view.highlights).toEqual(["guest:104"]);
    const unknown = await run("highlight_object", {
      id,
      objects: ["guest:999"],
    });
    expect(unknown.ok).toBe(false);
    expect(unknown.error).toContain("Onbekend object");
    expect(
      (await run("annotate_object", { id, object: "guest:104", text: "test" }))
        .ok,
    ).toBe(true);
    expect(
      (await run("focus_camera", { id, object: "guest:104", preset: "front" }))
        .ok,
    ).toBe(true);
    expect(service.get(id)!.view.camera).toMatchObject({
      focus: "guest:104",
      preset: "front",
      seq: 1,
    });
    expect((await run("focus_camera", { id })).ok).toBe(false);
    expect(
      (await run("rotate_object", { id, object: "*", axis: "y", degrees: 45 }))
        .ok,
    ).toBe(true);
    const details = await run("show_object_details", {
      id,
      object: "guest:104",
    });
    expect(details.ok).toBe(true);
    expect(
      (details.result as { object: { status: string } }).object.status,
    ).toBe("ok");
    expect(service.get(id)!.view.selected).toBe("guest:104");
    // Clearing highlights.
    await run("highlight_object", { id, objects: [], replace: true });
    expect(service.get(id)!.view.highlights).toEqual([]);
  });

  it("update_visualization only offers modes that fit and protects live data", async () => {
    const created = await run("create_visualization", { source: "proxmox" });
    const id = (created.result as { id: string }).id;
    expect(
      (await run("update_visualization", { id, mode: "wireframe" })).ok,
    ).toBe(true);
    const xray = await run("update_visualization", { id, mode: "xray" });
    expect(xray.ok).toBe(false);
    expect(xray.error).toContain("past niet bij deze inhoud");
    const overwrite = await run("update_visualization", {
      id,
      nodes: [{ id: "x", label: "x" }],
    });
    expect(overwrite.ok).toBe(false);
    expect(
      (await run("update_visualization", { id, dimension: "2d" })).ok,
    ).toBe(true);
    expect(service.get(id)!.view.dimension).toBe("2d");
  });

  it("custom graphs are validated; load_3d_scene refuses external urls", async () => {
    const bad = await run("create_visualization", {
      source: "custom",
      nodes: [{ id: "a", label: "A" }],
      edges: [{ from: "a", to: "nope" }],
    });
    expect(bad.ok).toBe(false);
    expect(bad.details).toEqual([expect.stringContaining("onbekende node")]);
    const ok = await run("create_visualization", {
      source: "custom",
      title: "Mijn graaf",
      nodes: [
        { id: "a", label: "A" },
        { id: "b", label: "B", parent: "a" },
      ],
      edges: [{ from: "a", to: "b" }],
    });
    expect(ok.ok).toBe(true);
    const external = await run("load_3d_scene", {
      title: "Model",
      models: [
        { label: "x", format: "stl", url: "https://evil.example/x.stl" },
      ],
    });
    expect(external.ok).toBe(false);
    expect(external.details?.join(" ")).toContain("geen externe host");
    const model = await run("load_3d_scene", {
      title: "Onderdeel",
      units: "mm",
      models: [
        {
          label: "Beugel",
          format: "stl",
          url: "/api/print/models/1.stl",
          layer: "onderdelen",
        },
      ],
      hotspots: [{ id: "h1", label: "Gat", position: [1, 2, 3] }],
    });
    expect(model.ok).toBe(true);
    const id = (model.result as { id: string }).id;
    expect(service.get(id)!.modes).toContain("xray");
    expect(
      (await run("highlight_object", { id, objects: ["h1", "any part name"] }))
        .ok,
    ).toBe(true);
  });

  it("export neutralises spreadsheet formulas and clear removes the scene", async () => {
    const created = await run("create_visualization", {
      source: "custom",
      nodes: [{ id: "a", label: '=HYPERLINK("x")' }],
    });
    const id = (created.result as { id: string }).id;
    const csv = await run("export_visualization", { id, format: "csv" });
    expect((csv.result as { content: string }).content).toContain(
      "'=HYPERLINK",
    );
    const cleared = await run("clear_visualization", { id });
    expect(cleared.visualization).toMatchObject({ action: "clear", id });
    expect(service.get(id)).toBeNull();
    expect((await run("clear_visualization", { id })).ok).toBe(false);
  });

  it("live scenes rebuild on read after their interval, share one rebuild and keep the last scene on failure", async () => {
    const scene = await service.create(
      "proxmox",
      {},
      new AbortController().signal,
    );
    let now = Date.now();
    service.now = () => now;
    const signal = new AbortController().signal;
    const before = builds;
    now += 6000;
    snapshot.guests[0]!.status = "stopped";
    const [a, b] = await Promise.all([
      service.read(scene.id, scene.revision, signal),
      service.read(scene.id, scene.revision, signal),
    ]);
    expect(builds - before).toBe(1);
    expect(a).toMatchObject({ scene: { revision: scene.revision + 1 } });
    expect(b).toMatchObject({ scene: { revision: scene.revision + 1 } });
    // Nothing changed: no new revision.
    now += 6000;
    const same = await service.read(scene.id, scene.revision + 1, signal);
    expect(same).toEqual({ unchanged: true, revision: scene.revision + 1 });
    failing = true;
    now += 6000;
    const kept = await service.read(scene.id, undefined, signal);
    failing = false;
    expect(kept).toMatchObject({ scene: { revision: scene.revision + 1 } });
    snapshot.guests[0]!.status = "running";
    service.now = Date.now;
  });
});

describe("when to open the holographic view", () => {
  it.each([
    "Toon mijn Proxmox",
    "Laat het netwerk zien",
    "Visualiseer mijn huis",
    "show my servers",
    "Laat mijn VM's maar zien",
    "Geef de topologie weer",
  ])("opens for %s", (message) => expect(isDisplayRequest(message)).toBe(true));

  it.each([
    "Welke VM's draaien er?",
    "Hoeveel VM's draaien er?",
    "Hoe is de status van de servers?",
    "Is mijn netwerk bereikbaar?",
    "Wat is het weer?",
  ])("does not open for the plain question %s", (message) =>
    expect(isDisplayRequest(message)).toBe(false),
  );

  it("resolves natural topics to provider types", () => {
    const registry = new VisualizationRegistry();
    registry.register(fakeProxmox);
    registry.register(fakeNetwork);
    expect(resolveTopic("proxmox", registry)).toBe("proxmox:topology");
    expect(resolveTopic("mijn servers", registry)).toBe("proxmox:topology");
    expect(resolveTopic("netwerk", registry)).toBe("network:overview");
    expect(resolveTopic("proxmox:topology", registry)).toBe("proxmox:topology");
    expect(resolveTopic("koelkast", registry)).toBeNull();
  });
});

describe("module wiring", () => {
  it("registers the four real providers when the application module boots", async () => {
    const { AppModule } = await import("../../src/app.module.js");
    const moduleRef = await Test.createTestingModule({
      imports: [AppModule],
    }).compile();
    await moduleRef.init();
    try {
      const registry = moduleRef.get(VisualizationRegistry);
      expect(
        registry
          .list()
          .map((p) => p.id)
          .sort(),
      ).toEqual(["ai-activity", "home-assistant", "network", "proxmox"]);
      expect(registry.info().find((p) => p.id === "proxmox")).toMatchObject({
        available: false,
      });
      const tools = moduleRef.get(ToolsService);
      expect(
        tools.list().filter((t) => t.source === "visualization"),
      ).toHaveLength(10);
    } finally {
      await moduleRef.close();
    }
  }, 60_000);
});

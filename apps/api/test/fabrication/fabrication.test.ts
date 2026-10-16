import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type {
  CadRender,
  CadWorkerPort,
} from "../../src/fabrication/cad.worker.js";
import {
  rankModels,
  UNSUPPORTED_PROVIDERS,
  type DiscoveryProvider,
  type RemoteModel,
} from "../../src/fabrication/discovery.js";
import { FabricationService } from "../../src/fabrication/fabrication.service.js";
import {
  describeJob,
  FabricationSource,
} from "../../src/fabrication/fabrication.source.js";
import { FabricationStore } from "../../src/fabrication/fabrication.store.js";
import { FabricationError } from "../../src/fabrication/fabrication.types.js";
import { writeBinaryStl } from "../../src/fabrication/mesh.js";
import { SimulatedPrinter } from "../../src/fabrication/printer.port.js";
import type {
  SlicerPort,
  SliceRequest,
  SliceResult,
} from "../../src/fabrication/slicer.port.js";
import { parseEstimates } from "../../src/fabrication/slicer.port.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { boxStl, boxTriangles } from "./fixtures.js";

let dir: string;
const emitted: Array<{ topic: string; payload: Record<string, unknown> }> = [];
const audit = { record: vi.fn() };

class FakeCad implements CadWorkerPort {
  engine = "fake";
  size: [number, number, number] = [120, 50, 60];
  calls = 0;
  failWith?: string;
  available() {
    return true;
  }
  async render(): Promise<CadRender> {
    this.calls++;
    if (this.failWith) return { ok: false, error: this.failWith };
    return { ok: true, stl: boxStl(...this.size), log: "" };
  }
}

class FakeSlicer implements SlicerPort {
  name = "fake";
  problem: string | null = null;
  requests: SliceRequest[] = [];
  unavailable() {
    return this.problem;
  }
  async slice(request: SliceRequest): Promise<SliceResult> {
    this.requests.push(request);
    return {
      ok: true,
      file: Buffer.alloc(200, 7),
      fileName: "part.gcode.3mf",
      minutes: 95,
      filamentGrams: 31.5,
      log: "",
    };
  }
}

function boot(
  overrides: {
    cad?: FakeCad;
    printer?: SimulatedPrinter;
    slicer?: FakeSlicer;
    providers?: DiscoveryProvider[];
  } = {},
) {
  const config = { dataFile: (n: string) => path.join(dir, n) } as NovaConfig;
  const cad = overrides.cad ?? new FakeCad();
  const printer = overrides.printer ?? new SimulatedPrinter();
  const slicer = overrides.slicer ?? new FakeSlicer();
  const service = new FabricationService(
    new FabricationStore(config),
    cad,
    printer,
    slicer,
    overrides.providers ?? [],
    audit as never,
    { emit: (e: (typeof emitted)[number]) => emitted.push(e) } as never,
  );
  service.recover();
  return { service, cad, printer, slicer };
}

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-fab-"));
  emitted.length = 0;
  audit.record.mockClear();
  process.env.NOVA_SLICER_PRINTER_PROFILE = "Bambu Lab P2S 0.4 nozzle";
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
  delete process.env.NOVA_SLICER_PRINTER_PROFILE;
});

const bracket = (service: FabricationService) =>
  service.generate({
    title: "Wandbeugel",
    template: "wall_bracket",
    params: { width: 120, holes: 4, holeDiameter: 5 },
  });

describe("designs", () => {
  it("generates from a template, measures the real mesh and stores files 0600", async () => {
    const { service } = boot();
    const { design, revision } = await bracket(service);
    expect(revision.report.bounds.size).toEqual([120, 50, 60]);
    expect(revision.params?.width).toBe(120);
    expect(revision.scad).toContain("cylinder");
    const model = path.join(dir, "fabrication", design.id, "r1.stl");
    expect(fs.statSync(model).mode & 0o777).toBe(0o600);
    expect(fs.statSync(path.join(dir, "fabrication.json")).mode & 0o777).toBe(
      0o600,
    );
  });

  it("rejects a render that does not match the promised dimensions and stores nothing", async () => {
    const cad = new FakeCad();
    cad.size = [130, 50, 60];
    const { service } = boot({ cad });
    await expect(bracket(service)).rejects.toThrow(/wijkt af/);
    expect(service.listDesigns()).toHaveLength(0);
    expect(fs.existsSync(path.join(dir, "fabrication"))).toBe(false);
  });

  it("reports a CAD failure with its log and keeps the library clean", async () => {
    const cad = new FakeCad();
    cad.failWith = "OpenSCAD kon het model niet maken.";
    const { service } = boot({ cad });
    await expect(
      service.generate({ title: "x", scad: "cube(" }),
    ).rejects.toThrow(/OpenSCAD/);
    expect(service.listDesigns()).toHaveLength(0);
  });

  it("modifies parameters into revisions with undo and redo, and a new change drops the redo tail", async () => {
    const { service, cad } = boot();
    const { design } = await bracket(service);
    cad.size = [140, 50, 60];
    const r2 = await service.modify(design.id, {
      changes: { width: 140 },
      note: "breder",
    });
    expect(r2.revision.n).toBe(2);
    expect(r2.revision.params).toMatchObject({ width: 140, holes: 4 });
    expect(service.undo(design.id).revision.n).toBe(1);
    expect(service.model(design.id)).toEqual(service.model(design.id, 1));
    expect(service.redo(design.id).revision.n).toBe(2);
    service.undo(design.id);
    cad.size = [120, 50, 70];
    const r3 = await service.modify(design.id, { changes: { height: 70 } });
    expect(r3.design.revisions.map((r) => r.n)).toEqual([1, 3]);
    expect(() => service.redo(design.id)).toThrow(/niets/);
    expect(
      fs.existsSync(path.join(dir, "fabrication", design.id, "r2.stl")),
    ).toBe(false);
  });

  it("refuses unknown parameters and keeps the old revision when a modification fails", async () => {
    const { service, cad } = boot();
    const { design } = await bracket(service);
    await expect(
      service.modify(design.id, { changes: { colour: 3 } }),
    ).rejects.toThrow(/geen parameter/);
    cad.failWith = "boom";
    await expect(
      service.modify(design.id, { changes: { width: 130 } }),
    ).rejects.toThrow();
    expect(service.design(design.id).revisions).toHaveLength(1);
  });

  it("survives a restart", async () => {
    const first = boot();
    const { design } = await bracket(first.service);
    const second = boot();
    expect(second.service.design(design.id).title).toBe("Wandbeugel");
    expect(second.service.model(design.id).length).toBeGreaterThan(84);
  });

  it("validates and repairs a revision as a new revision", async () => {
    const { service } = boot();
    const { design } = await bracket(service);
    const fixed = service.validate(design.id, undefined, true);
    expect(fixed.repaired).toBe(true);
    expect(fixed.revision.n).toBe(2);
    expect(service.design(design.id).revisions).toHaveLength(2);
  });
});

describe("slicing", () => {
  it("slices for the P2S profile only and keeps unknown estimates unknown", async () => {
    const { service, slicer } = boot();
    const { design } = await bracket(service);
    const job = await service.slice(design.id, { material: "pla" });
    expect(slicer.requests[0]).toMatchObject({
      printerProfile: "Bambu Lab P2S 0.4 nozzle",
      material: "PLA",
      nozzle: 0.4,
    });
    expect(job.state).toBe("sliced");
    expect(job.estimates).toEqual({ minutes: 95, filamentGrams: 31.5 });
    expect(describeJob(job).estimatedMinutes).toBe(95);
  });

  it("fails clearly without a slicer, with a wrong profile, an unknown material or an unprintable model", async () => {
    const slicer = new FakeSlicer();
    const { service } = boot({ slicer });
    const { design } = await bracket(service);
    slicer.problem = "Er is geen slicer ingesteld";
    await expect(service.slice(design.id, { material: "PLA" })).rejects.toThrow(
      /geen slicer/,
    );
    slicer.problem = null;
    process.env.NOVA_SLICER_PRINTER_PROFILE = "Bambu Lab X1C";
    await expect(service.slice(design.id, { material: "PLA" })).rejects.toThrow(
      /P2S-profiel/,
    );
    process.env.NOVA_SLICER_PRINTER_PROFILE = "Bambu Lab P2S";
    await expect(
      service.slice(design.id, { material: "unobtainium" }),
    ).rejects.toThrow(/materiaal/i);
    const big = new FakeCad();
    big.size = [300, 50, 60];
    const second = boot({ cad: big });
    await expect(
      second.service.generate({
        title: "groot",
        template: "plate",
        params: { width: 250, depth: 250, thickness: 4 },
      }),
    ).rejects.toBeInstanceOf(FabricationError);
  });

  it("refuses to slice a model with errors", async () => {
    const { service } = boot();
    const tri = boxTriangles(20, 20, 20);
    const store = new FabricationStore({
      dataFile: (n: string) => path.join(dir, n),
    } as NovaConfig);
    // import an open mesh through the public path: a downloaded STL with a hole
    const provider = fakeProvider(writeBinaryStl(tri.slice(0, tri.length - 9)));
    const second = boot({ providers: [provider] });
    const { design } = await second.service.download("fake", "1", undefined);
    await expect(
      second.service.slice(design.id, { material: "PLA" }),
    ).rejects.toThrow(/niet printklaar/);
    void service;
    void store;
  });
});

async function readyJob(env: ReturnType<typeof boot>) {
  const { design } = await bracket(env.service);
  const job = await env.service.slice(design.id, { material: "PLA" });
  const prepared = await env.service.prepare(job.id);
  return { job, prepared };
}

describe("print job state machine", () => {
  it("runs sliced → awaiting_approval → approved → printing → completed with one submission", async () => {
    const env = boot();
    const { job, prepared } = await readyJob(env);
    expect(prepared.ready).toBe(true);
    expect(prepared.unverified.join(" ")).toMatch(/bouwplaat/);
    expect(job.state).toBe("awaiting_approval");
    env.service.approve(job.id);
    expect(job.state).toBe("approved");
    await env.service.submit(job.id);
    expect(job.state).toBe("printing");
    expect(env.printer.received).toHaveLength(1);
    expect(env.printer.received[0]!.jobName).toBe(`nova-${job.id}`);
    env.printer.advance(50);
    expect((await env.service.monitor(job.id)).status.progressPercent).toBe(50);
    env.printer.advance(60);
    await env.service.monitor(job.id);
    expect(job.state).toBe("completed");
    expect(
      emitted.some((e) => String(e.payload.title).startsWith("Print klaar")),
    ).toBe(true);
  });

  it("never submits without approval, and never twice", async () => {
    const env = boot();
    const { job } = await readyJob(env);
    await expect(env.service.submit(job.id)).rejects.toThrow(
      /niet goedgekeurd/,
    );
    env.service.approve(job.id);
    await env.service.submit(job.id);
    await expect(env.service.submit(job.id)).rejects.toThrow();
    expect(env.printer.received).toHaveLength(1);
  });

  it("cannot approve before the readiness check, and approval does not survive a changed slice", async () => {
    const env = boot();
    const { design } = await bracket(env.service);
    const job = await env.service.slice(design.id, { material: "PLA" });
    expect(() => env.service.approve(job.id)).toThrow(/voor/);
    await env.service.prepare(job.id);
    env.service.approve(job.id);
    job.sliceSha = "0".repeat(64);
    await expect(env.service.submit(job.id)).rejects.toThrow(
      /goedgekeuring hoort niet bij/,
    );
    expect(env.printer.received).toHaveLength(0);
  });

  it("blocks on a busy printer, a wrong nozzle, missing material, another job or an error, and lists unverifiable signals", async () => {
    const env = boot();
    const { design } = await bracket(env.service);
    const job = await env.service.slice(design.id, { material: "PETG" });
    let r = await env.service.prepare(job.id);
    expect(r.blockers.join(" ")).toMatch(/geen PETG/);
    env.printer.materials = [{ slot: "A1", type: "PETG" }];
    env.printer.nozzleDiameter = 0.6;
    r = await env.service.prepare(job.id);
    expect(r.blockers.join(" ")).toMatch(/0\.6 mm/);
    env.printer.nozzleDiameter = 0.4;
    env.printer.setReachable(false);
    r = await env.service.prepare(job.id);
    expect(r.ready).toBe(false);
    env.printer.setReachable(true);
    r = await env.service.prepare(job.id);
    expect(r.ready).toBe(true);
    expect(job.state).toBe("awaiting_approval");
    env.printer.materials = [];
    r = await env.service.prepare(job.id);
    expect(r.unverified.join(" ")).toMatch(/filament is niet uit te lezen/);
  });

  it("a refused start fails the job and allows nothing to be left half-submitted", async () => {
    const env = boot();
    const { job } = await readyJob(env);
    env.service.approve(job.id);
    env.printer.failNextStart = "refuse";
    await env.service.submit(job.id);
    expect(job.state).toBe("failed");
    expect(env.printer.received).toHaveLength(0);
  });

  it("an uncertain start becomes unknown and is never retried; the monitor resolves it only when the printer shows this job", async () => {
    const env = boot();
    env.printer.startsDespiteUncertain = true;
    const { job } = await readyJob(env);
    env.service.approve(job.id);
    env.printer.failNextStart = "uncertain";
    await env.service.submit(job.id);
    expect(job.state).toBe("unknown");
    expect(emitted.some((e) => e.payload.severity === "warning")).toBe(true);
    await expect(env.service.submit(job.id)).rejects.toThrow();
    expect(env.printer.received).toHaveLength(1);
    await env.service.monitor(job.id);
    expect(job.state).toBe("printing");
  });

  it("an uncertain start that never reached the printer stays unknown and blocks new jobs from starting", async () => {
    const env = boot();
    const { job } = await readyJob(env);
    env.service.approve(job.id);
    env.printer.failNextStart = "uncertain";
    await env.service.submit(job.id);
    await env.service.monitor(job.id);
    expect(job.state).toBe("unknown");
    const { design } = await bracket(env.service);
    const second = await env.service.slice(design.id, { material: "PLA" });
    expect((await env.service.prepare(second.id)).blockers.join(" ")).toMatch(
      /andere printopdracht/,
    );
  });

  it("recovers a submission that was in flight during a restart as unknown, without sending again", async () => {
    const env = boot();
    const { job } = await readyJob(env);
    env.service.approve(job.id);
    const raw = JSON.parse(
      fs.readFileSync(path.join(dir, "fabrication.json"), "utf8"),
    );
    raw.jobs[0].state = "submitting";
    fs.writeFileSync(path.join(dir, "fabrication.json"), JSON.stringify(raw));
    const after = boot({ printer: env.printer });
    expect(after.service.job(job.id).state).toBe("unknown");
    expect(env.printer.received).toHaveLength(0);
  });

  it("pause, resume and cancel follow the printer state", async () => {
    const env = boot();
    const { job } = await readyJob(env);
    env.service.approve(job.id);
    await env.service.submit(job.id);
    await expect(env.service.command(job.id, "resume")).rejects.toThrow();
    await env.service.command(job.id, "pause");
    expect(job.state).toBe("paused");
    await env.service.command(job.id, "resume");
    await env.service.command(job.id, "cancel");
    expect(job.state).toBe("cancelled");
  });

  it("detects a printer error during the print", async () => {
    const env = boot();
    const { job } = await readyJob(env);
    env.service.approve(job.id);
    await env.service.submit(job.id);
    env.printer.breakDown("Filament op");
    await env.service.monitor(job.id);
    expect(job.state).toBe("failed");
    expect(job.outcome).toContain("Filament");
  });

  it("keeps history newest first", async () => {
    const env = boot();
    const a = await readyJob(env);
    env.service.now = () => Date.now() + 1000;
    const b = await readyJob(env);
    expect(env.service.history().map((j) => j.id)).toEqual([
      b.job.id,
      a.job.id,
    ]);
  });
});

describe("tools", () => {
  it("exposes the specified tools with physical actions gated", () => {
    const { service } = boot();
    const source = new FabricationSource(service, {} as never);
    const defs = Object.fromEntries(
      source.definitions().map((d) => [d.name, d]),
    );
    for (const name of [
      "search_3d_models",
      "get_3d_model_details",
      "download_3d_model",
      "generate_3d_model",
      "modify_3d_model",
      "validate_3d_model",
      "export_3d_model",
      "load_holographic_preview",
      "slice_3d_model",
      "get_printer_status",
      "get_printer_materials",
      "prepare_print_job",
      "approve_print_job",
      "submit_print_job",
      "monitor_print_job",
      "pause_print_job",
      "resume_print_job",
      "cancel_print_job",
      "get_print_history",
    ])
      expect(defs[name], name).toBeDefined();
    expect(defs.submit_print_job!.risk).toBe("DANGEROUS");
    expect(defs.cancel_print_job!.risk).toBe("DANGEROUS");
    for (const name of [
      "submit_print_job",
      "cancel_print_job",
      "approve_print_job",
      "pause_print_job",
      "resume_print_job",
    ])
      expect(defs[name]!.allowStandingApproval, name).toBe(false);
    for (const name of [
      "approve_print_job",
      "pause_print_job",
      "resume_print_job",
    ])
      expect(["CONFIRM", "DANGEROUS"]).toContain(defs[name]!.risk);
    expect(defs.get_printer_status!.risk).toBe("READ_ONLY");
  });

  it("turns failures into Dutch errors and reports an unlinked printer honestly", async () => {
    const { service } = boot();
    const source = new FabricationSource(service, {} as never);
    const call = { signal: new AbortController().signal };
    expect(
      await source.execute("submit_print_job", { jobId: "nope" }, call),
    ).toMatchObject({
      ok: false,
      error: expect.stringContaining("niet gevonden"),
    });
    expect(
      await source.execute("generate_3d_model", { title: "x" }, call),
    ).toMatchObject({ ok: false, error: expect.stringContaining("sjabloon") });
    const status = await source.execute("get_printer_status", {}, call);
    expect(status.ok).toBe(true);
    expect((status.result as { simulated: boolean }).simulated).toBe(true);
  });

  it("submit via the tool reports an unknown outcome as not-ok and never claims success", async () => {
    const env = boot();
    const { job } = await readyJob(env);
    env.service.approve(job.id);
    env.printer.failNextStart = "uncertain";
    const source = new FabricationSource(env.service, {} as never);
    const result = await source.execute(
      "submit_print_job",
      { jobId: job.id },
      { signal: new AbortController().signal },
    );
    expect(result.ok).toBe(false);
    expect(result.error).toMatch(/onbekend/);
  });

  it("opens the holographic viewer with the real model URL, not a made-up scene", async () => {
    const env = boot();
    const { design } = await bracket(env.service);
    const createCustom = vi.fn(() => ({ id: "viz-1" }));
    const eventFor = vi.fn(() => ({ action: "open" }));
    const source = new FabricationSource(env.service, {
      createCustom,
      eventFor,
    } as never);
    const result = await source.execute(
      "load_holographic_preview",
      { designId: design.id },
      { signal: new AbortController().signal },
    );
    expect(result.ok).toBe(true);
    const scene = (
      createCustom.mock.calls[0] as unknown as [
        { models: { url: string; format: string }[]; units: string },
      ]
    )[0];
    expect(scene.models[0]).toMatchObject({
      format: "stl",
      url: `/api/fabrication/designs/${design.id}/revisions/1/model.stl`,
    });
    expect(scene.units).toBe("mm");
    expect(result.visualization).toBeDefined();
  });
});

function fakeProvider(
  stl: Buffer,
  models: RemoteModel[] = [],
): DiscoveryProvider {
  return {
    name: "fake",
    state: () => ({ name: "fake", status: "ready" }),
    search: async () => models,
    details: async (id) => ({
      model: {
        provider: "fake",
        id,
        title: "Downloaded thing",
        url: "https://example.test/1",
        creator: "alice",
        license: "CC-BY",
      },
      files: [
        {
          id: "f1",
          name: "thing.stl",
          format: "stl",
          url: "https://example.test/f1",
        },
        {
          id: "f2",
          name: "thing.3mf",
          format: "3mf",
          url: "https://example.test/f2",
        },
      ],
    }),
    download: async () => stl,
  };
}

describe("discovery", () => {
  it("imports a downloaded STL as a validated design with licence and creator, never printed", async () => {
    const { service } = boot({ providers: [fakeProvider(boxStl(20, 20, 20))] });
    const { design, revision } = await service.download("fake", "1", undefined);
    expect(design.origin).toMatchObject({
      kind: "downloaded",
      creator: "alice",
      license: "CC-BY",
    });
    expect(revision.engine).toBe("imported");
    expect(revision.report.watertight).toBe(true);
    await expect(
      service.modify(design.id, { changes: { width: 5 } }),
    ).rejects.toThrow(/geen parameters/);
  });

  it("refuses files that are not meshes and 3MF it cannot import", async () => {
    const { service } = boot({
      providers: [fakeProvider(Buffer.from("MZ\x90\x00 this is an exe"))],
    });
    await expect(service.download("fake", "1", undefined)).rejects.toThrow(
      /STL/,
    );
    await expect(service.download("fake", "1", "f2")).rejects.toThrow(
      /Alleen STL/,
    );
  });

  it("reports a failing provider and unsupported repositories instead of inventing results", async () => {
    const broken: DiscoveryProvider = {
      ...fakeProvider(boxStl(1, 1, 1)),
      search: async () => {
        throw new Error("rate_limited");
      },
    };
    const { service } = boot({ providers: [broken] });
    const found = await service.search("xbox controller wall mount");
    expect(found.results).toEqual([]);
    expect(found.errors[0]).toMatch(/limiet/);
    expect(found.providers.map((p) => p.name)).toEqual(
      expect.arrayContaining(["printables", "makerworld"]),
    );
    expect(UNSUPPORTED_PROVIDERS.every((p) => p.status === "unsupported")).toBe(
      true,
    );
  });

  it("dedupes and ranks by relevance, popularity and a known licence", () => {
    const m = (
      id: string,
      title: string,
      extra: Partial<RemoteModel> = {},
    ): RemoteModel => ({
      provider: "t",
      id,
      title,
      url: "u",
      creator: "a",
      ...extra,
    });
    const ranked = rankModels(
      [
        m("1", "Xbox controller wall mount", { likes: 10 }),
        m("2", "Xbox controller wall mount", { likes: 10 }),
        m("3", "Benchy boat", { likes: 9999 }),
        m("4", "Controller wall mount for Xbox", {
          likes: 500,
          license: "CC-BY",
        }),
      ],
      "xbox controller wall mount",
    );
    expect(ranked.map((x) => x.id)).toEqual(["4", "1", "3"]);
  });
});

describe("slicer estimates", () => {
  it("parses header estimates and leaves unknowns null", () => {
    expect(
      parseEstimates(
        "; total estimated time: 1h 35m 30s\n; total filament weight [g] : 31.5",
      ),
    ).toEqual({ minutes: 96, filamentGrams: 31.5 });
    expect(parseEstimates("nothing here")).toEqual({
      minutes: null,
      filamentGrams: null,
    });
  });
});

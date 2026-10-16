import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  CadWorkerRouter,
  WindowsAgentCadWorker,
  WindowsFabAgent,
  type CadRender,
  type CadWorkerPort,
} from "../../src/fabrication/cad.worker.js";
import {
  ConfiguredCliSlicer,
  SlicerRouter,
  WindowsAgentSlicer,
  type SliceRequest,
} from "../../src/fabrication/slicer.port.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { boxStl } from "./fixtures.js";

interface Agent {
  status: Record<string, unknown>;
  renders: string[];
  slices: { query: URLSearchParams; bytes: number }[];
  renderReply: "ok" | "model-error" | "refused";
  sliceReply: "ok" | "error";
  auth: (string | undefined)[];
}

let agent: Agent;
let server: http.Server;
let url: string;

beforeEach(async () => {
  agent = {
    status: {
      ok: true,
      enabled: true,
      openscad: true,
      slicer: true,
      slicerProfile: "Bambu Lab P2S 0.4 nozzle",
    },
    renders: [],
    slices: [],
    renderReply: "ok",
    sliceReply: "ok",
    auth: [],
  };
  server = http.createServer((req, res) => {
    agent.auth.push(req.headers.authorization);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const body = Buffer.concat(chunks);
      const u = new URL(req.url ?? "/", "http://x");
      if (u.pathname === "/v1/fab/status") {
        res.setHeader("content-type", "application/json");
        return void res.end(JSON.stringify(agent.status));
      }
      if (u.pathname === "/v1/fab/render") {
        agent.renders.push(body.toString("utf8"));
        if (agent.renderReply === "refused")
          return void res.writeHead(409).end("{}");
        if (agent.renderReply === "model-error") {
          res.writeHead(422, { "content-type": "application/json" });
          return void res.end(
            JSON.stringify({
              ok: false,
              error: "x",
              log: "ERROR: Parser error in line 1",
            }),
          );
        }
        res.writeHead(200, { "content-type": "application/octet-stream" });
        return void res.end(boxStl(10, 20, 30));
      }
      if (u.pathname === "/v1/fab/slice") {
        agent.slices.push({ query: u.searchParams, bytes: body.length });
        if (agent.sliceReply === "error") {
          res.writeHead(422, { "content-type": "application/json" });
          return void res.end(
            JSON.stringify({ ok: false, error: "x", log: "slicer exploded" }),
          );
        }
        res.writeHead(200, {
          "content-type": "application/octet-stream",
          "x-nova-file-name": "out.gcode.3mf",
          "x-nova-estimate": Buffer.from(
            "; total estimated time: 1h 2m 3s\n; total filament weight [g] : 12.5\n",
          ).toString("base64"),
        });
        return void res.end(Buffer.alloc(300, 9));
      }
      res.writeHead(404).end("{}");
    });
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});
afterEach(async () => {
  delete process.env.NOVA_FAB_BACKEND;
  await new Promise<void>((r) => server.close(() => r()));
});

const config = (agentUrl: string) =>
  ({
    windowsAgent: { url: agentUrl, token: "tok" },
    stackControlUrl: "",
    stackControlToken: "",
  }) as unknown as NovaConfig;

class FakeServerCad implements CadWorkerPort {
  engine = "server";
  calls = 0;
  available() {
    return true;
  }
  async render(): Promise<CadRender> {
    this.calls++;
    return { ok: true, stl: boxStl(1, 1, 1), log: "" };
  }
}

function cad(agentUrl = url) {
  const fab = new WindowsFabAgent(config(agentUrl));
  const windows = new WindowsAgentCadWorker(fab);
  const serverCad = new FakeServerCad();
  return {
    router: new CadWorkerRouter(windows, serverCad as never),
    windows,
    serverCad,
    fab,
  };
}

describe("CAD on the Windows PC", () => {
  it("renders on the PC with the agent's bearer token and never touches the server", async () => {
    const { router, serverCad } = cad();
    const r = await router.render("cube([10,20,30]);");
    expect(r.ok).toBe(true);
    expect(agent.renders).toEqual(["cube([10,20,30]);"]);
    expect(agent.auth.every((a) => a === "Bearer tok")).toBe(true);
    expect(serverCad.calls).toBe(0);
  });

  it("falls back to the server container only when the PC cannot be used", async () => {
    agent.status.openscad = false;
    const a = cad();
    expect((await a.router.render("cube(1);")).ok).toBe(true);
    expect(a.serverCad.calls).toBe(1);
    expect(agent.renders).toEqual([]);

    agent.status.openscad = true;
    agent.renderReply = "refused";
    const b = cad();
    expect((await b.router.render("cube(1);")).ok).toBe(true);
    expect(b.serverCad.calls).toBe(1);

    const c = cad("http://127.0.0.1:9"); // nothing listens: PC is off
    expect((await c.router.render("cube(1);")).ok).toBe(true);
    expect(c.serverCad.calls).toBe(1);
  });

  it("does not retry a genuine OpenSCAD error on the server", async () => {
    agent.renderReply = "model-error";
    const { router, serverCad } = cad();
    const r = await router.render("cube(");
    expect(r).toMatchObject({
      ok: false,
      log: expect.stringContaining("Parser error"),
    });
    expect(serverCad.calls).toBe(0);
  });

  it("honours NOVA_FAB_BACKEND=windows and =server", async () => {
    process.env.NOVA_FAB_BACKEND = "windows";
    agent.status.enabled = false;
    const a = cad();
    const r = await a.router.render("cube(1);");
    expect(r).toMatchObject({ ok: false, unavailable: true });
    expect((r as { error: string }).error).toMatch(/staat uit op de pc/);
    expect(a.serverCad.calls).toBe(0);

    process.env.NOVA_FAB_BACKEND = "server";
    agent.status.enabled = true;
    const b = cad();
    expect((await b.router.render("cube(1);")).ok).toBe(true);
    expect(agent.renders).toEqual([]);
    expect(b.serverCad.calls).toBe(1);
  });

  it("reports the PC being off in Dutch when no fallback exists", async () => {
    const fab = new WindowsFabAgent(config("http://127.0.0.1:9"));
    const r = await new WindowsAgentCadWorker(fab).render("cube(1);");
    expect(r).toMatchObject({ ok: false, unavailable: true });
    expect((r as { error: string }).error).toMatch(/Windows-pc antwoordt niet/);
  });
});

const request: SliceRequest = {
  model: boxStl(20, 20, 20),
  printerProfile: "Bambu Lab P2S 0.4 nozzle",
  material: "PLA",
  nozzle: 0.4,
  layerHeight: 0.2,
  infillPercent: 15,
  walls: 3,
  supports: "off",
};

function slicer() {
  const fab = new WindowsFabAgent(config(url));
  const windows = new WindowsAgentSlicer(fab);
  return {
    router: new SlicerRouter(windows, new ConfiguredCliSlicer()),
    windows,
  };
}

describe("slicing on the Windows PC", () => {
  it("sends the model and validated settings and parses the estimates the PC returns", async () => {
    const { router } = slicer();
    expect(await router.unavailable()).toBeNull();
    expect(await router.profileName()).toBe("Bambu Lab P2S 0.4 nozzle");
    const r = await router.slice(request);
    expect(r).toMatchObject({
      ok: true,
      fileName: "out.gcode.3mf",
      minutes: 62,
      filamentGrams: 12.5,
    });
    expect(agent.slices[0]!.bytes).toBe(request.model.length);
    expect(Object.fromEntries(agent.slices[0]!.query)).toEqual({
      profile: "Bambu Lab P2S 0.4 nozzle",
      material: "PLA",
      nozzle: "0.4",
      layer: "0.2",
      infill: "15",
      walls: "3",
      supports: "off",
    });
  });

  it("explains why slicing is unavailable on the PC, and uses no server command unless one is configured", async () => {
    agent.status.slicer = false;
    const { router } = slicer();
    expect(await router.unavailable()).toMatch(/geen P2S-slicer/);
    expect(await router.slice(request)).toMatchObject({ ok: false });
    agent.status.enabled = false;
    const off = slicer();
    expect(await off.router.unavailable()).toMatch(/staat uit op de pc/);
  });

  it("returns the slicer's log on failure", async () => {
    agent.sliceReply = "error";
    const r = await slicer().router.slice(request);
    expect(r).toMatchObject({
      ok: false,
      log: expect.stringContaining("exploded"),
    });
  });

  it("forcing the server backend never calls the PC", async () => {
    process.env.NOVA_FAB_BACKEND = "server";
    const before = agent.slices.length;
    const { router } = slicer();
    expect(await router.unavailable()).toMatch(/geen slicer ingesteld/);
    await router.slice(request);
    expect(agent.slices.length).toBe(before);
  });
});

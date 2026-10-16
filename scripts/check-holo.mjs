// Browser gate for the holographic viewer: opens the real shell with a mocked API, opens the
// view from the menu, and checks rendering, modes, selection, layers, measuring, the table
// fallback, STL/GLB/3MF loading, the "no idle render loop" promise and disposal.
//   node scripts/check-holo.mjs            (default https://localhost:5173, or NOVA_HOLO_TEST_URL)
import { chromium } from "playwright-core";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { ALL as CARD_FIXTURES } from "./holo-card-fixtures.mjs";
/* global document, window, HTMLCanvasElement, WebGLRenderingContext, WebGL2RenderingContext, Image */
const base = process.env.NOVA_HOLO_TEST_URL ?? "https://localhost:5173";
const shots = process.env.NOVA_HOLO_SHOTS ?? "";
if (shots) fs.mkdirSync(shots, { recursive: true });

// ---------- fixtures ----------
const view = () => ({
  highlights: [],
  annotations: [],
  hiddenLayers: [],
  rotations: [],
});
const common = (id, title, kind) => ({
  schema: 1,
  id,
  title,
  kind,
  providerId: "proxmox",
  typeId: "topology",
  revision: 1,
  updatedAt: new Date().toISOString(),
  layers: [],
  notes: [],
  actions: [],
  view: view(),
});
const topology = () => {
  const nodes = [
    {
      id: "cluster",
      label: "Proxmox",
      kind: "cluster",
      status: "ok",
      layer: "nodes",
      size: 1.6,
      value: 0.2,
    },
  ];
  const edges = [];
  for (const n of ["pve1", "pve2"]) {
    nodes.push({
      id: `node:${n}`,
      label: n,
      kind: "node",
      parent: "cluster",
      status: n === "pve2" ? "critical" : "ok",
      layer: "nodes",
      value: n === "pve2" ? null : 0.4,
      detail: { cpu: "40%", toestand: "online" },
    });
    edges.push({ from: "cluster", to: `node:${n}`, label: "bevat" });
    for (let i = 0; i < 5; i++) {
      const id = `guest:${n}${i}`;
      const status = ["ok", "off", "warning", "unknown", "ok"][i];
      nodes.push({
        id,
        label: `${n}-vm${i}`,
        kind: i % 2 ? "lxc" : "vm",
        parent: `node:${n}`,
        status,
        layer: "guests",
        value: status === "ok" ? 0.3 + i / 10 : null,
        detail: { vmid: 100 + i, cpu: "12%" },
      });
      edges.push({ from: `node:${n}`, to: id, label: "draait op" });
    }
  }
  nodes.push({
    id: "storage:local",
    label: "local",
    kind: "storage",
    parent: "node:pve1",
    status: "warning",
    layer: "storage",
    value: 0.85,
  });
  edges.push({ from: "node:pve1", to: "storage:local", label: "opslag" });
  return {
    ...common("viz-0000000001", "Proxmox-topologie", "graph"),
    nodes,
    edges,
    refreshMs: 15000,
    layers: [
      { id: "nodes", label: "Nodes" },
      { id: "guests", label: "VM's en containers" },
      { id: "storage", label: "Opslag" },
    ],
    modes: ["holographic", "realistic", "wireframe", "heatmap"],
    defaultMode: "holographic",
    heatLabel: "CPU-belasting",
    notes: ["Bron: de Proxmox-API."],
    actions: [{ id: "a", label: "Start pve1-vm1", prompt: "Start VM 101" }],
  };
};
const chart = () => ({
  ...common("viz-0000000002", "Proxmox-belasting", "chart"),
  chart: {
    type: "bar",
    unit: "%",
    max: 100,
    series: [
      {
        label: "CPU",
        points: [
          { label: "pve1", value: 40, status: "ok" },
          { label: "pve2", value: null, status: "unknown" },
        ],
      },
    ],
  },
  modes: ["realistic"],
  defaultMode: "realistic",
});
const model = (format, url) => ({
  ...common(
    `viz-00000000${format.length}${format === "stl" ? 3 : format === "glb" ? 4 : 5}`,
    `Model ${format}`,
    "model",
  ),
  providerId: "custom",
  typeId: "model",
  models: [{ id: "m1", label: "Kubus", format, url }],
  units: "mm",
  hotspots: [
    {
      id: "h1",
      label: "Hoek",
      position: format === "glb" ? [0.5, 0.5, 0.5] : [10, 10, 10],
      detail: { notitie: "testpunt" },
    },
  ],
  modes: ["holographic", "realistic", "wireframe", "technical", "xray"],
  defaultMode: "holographic",
});

const cubeStl = () => {
  const v = [
    [0, 0, 0],
    [1, 0, 0],
    [1, 1, 0],
    [0, 1, 0],
    [0, 0, 1],
    [1, 0, 1],
    [1, 1, 1],
    [0, 1, 1],
  ].map((p) => p.map((c) => c * 20));
  const f = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [2, 3, 7],
    [2, 7, 6],
    [1, 2, 6],
    [1, 6, 5],
    [3, 0, 4],
    [3, 4, 7],
  ];
  const buf = Buffer.alloc(84 + 50 * f.length);
  buf.writeUInt32LE(f.length, 80);
  f.forEach((tri, i) => {
    let at = 84 + i * 50 + 12;
    for (const idx of tri)
      for (const c of v[idx]) {
        buf.writeFloatLE(c, at);
        at += 4;
      }
  });
  return buf;
};
const cubeGlb = () => {
  const pos = new Float32Array([
    0, 0, 0, 1, 0, 0, 1, 1, 0, 0, 1, 0, 0, 0, 1, 1, 0, 1, 1, 1, 1, 0, 1, 1,
  ]);
  const idx = new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4, 2, 3, 7, 2, 7, 6, 1,
    2, 6, 1, 6, 5, 3, 0, 4, 3, 4, 7,
  ]);
  const bin = Buffer.concat([Buffer.from(pos.buffer), Buffer.from(idx.buffer)]);
  const json = {
    asset: { version: "2.0" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "Kubus" }],
    meshes: [
      {
        name: "Kubus",
        primitives: [{ attributes: { POSITION: 0 }, indices: 1 }],
      },
    ],
    buffers: [{ byteLength: bin.length }],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: pos.byteLength, target: 34962 },
      {
        buffer: 0,
        byteOffset: pos.byteLength,
        byteLength: idx.byteLength,
        target: 34963,
      },
    ],
    accessors: [
      {
        bufferView: 0,
        componentType: 5126,
        count: 8,
        type: "VEC3",
        min: [0, 0, 0],
        max: [1, 1, 1],
      },
      { bufferView: 1, componentType: 5123, count: idx.length, type: "SCALAR" },
    ],
  };
  let j = Buffer.from(JSON.stringify(json));
  j = Buffer.concat([j, Buffer.alloc((4 - (j.length % 4)) % 4, 0x20)]);
  const b = Buffer.concat([bin, Buffer.alloc((4 - (bin.length % 4)) % 4)]);
  const head = Buffer.alloc(12);
  head.write("glTF");
  head.writeUInt32LE(2, 4);
  head.writeUInt32LE(12 + 8 + j.length + 8 + b.length, 8);
  const c1 = Buffer.alloc(8);
  c1.writeUInt32LE(j.length, 0);
  c1.write("JSON", 4);
  const c2 = Buffer.alloc(8);
  c2.writeUInt32LE(b.length, 0);
  c2.write("BIN\0", 4);
  return Buffer.concat([head, c1, j, c2, b]);
};
const zip = (files) => {
  const parts = [];
  const central = [];
  let offset = 0;
  for (const [name, data] of files) {
    const raw = Buffer.from(data);
    const comp = zlib.deflateRawSync(raw);
    const crc = zlib.crc32(raw);
    const nm = Buffer.from(name);
    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(8, 8);
    lh.writeUInt32LE(crc >>> 0, 14);
    lh.writeUInt32LE(comp.length, 18);
    lh.writeUInt32LE(raw.length, 22);
    lh.writeUInt16LE(nm.length, 26);
    parts.push(lh, nm, comp);
    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(8, 10);
    ch.writeUInt32LE(crc >>> 0, 16);
    ch.writeUInt32LE(comp.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nm.length, 28);
    ch.writeUInt32LE(offset, 42);
    central.push(ch, nm);
    offset += 30 + nm.length + comp.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(cd.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
};
const cube3mf = () => {
  const verts = [
    [0, 0, 0],
    [20, 0, 0],
    [20, 20, 0],
    [0, 20, 0],
    [0, 0, 20],
    [20, 0, 20],
    [20, 20, 20],
    [0, 20, 20],
  ];
  const tris = [
    [0, 2, 1],
    [0, 3, 2],
    [4, 5, 6],
    [4, 6, 7],
    [0, 1, 5],
    [0, 5, 4],
    [2, 3, 7],
    [2, 7, 6],
    [1, 2, 6],
    [1, 6, 5],
    [3, 0, 4],
    [3, 4, 7],
  ];
  const model = `<?xml version="1.0" encoding="UTF-8"?><model unit="millimeter" xml:lang="en-US" xmlns="http://schemas.microsoft.com/3dmanufacturing/core/2015/02"><resources><object id="1" type="model"><mesh><vertices>${verts.map((p) => `<vertex x="${p[0]}" y="${p[1]}" z="${p[2]}"/>`).join("")}</vertices><triangles>${tris.map((t) => `<triangle v1="${t[0]}" v2="${t[1]}" v3="${t[2]}"/>`).join("")}</triangles></mesh></object></resources><build><item objectid="1"/></build></model>`;
  return zip([
    [
      "[Content_Types].xml",
      `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="model" ContentType="application/vnd.ms-package.3dmanufacturing-3dmodel+xml"/></Types>`,
    ],
    [
      "_rels/.rels",
      `<?xml version="1.0" encoding="UTF-8"?><Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Target="/3D/3dmodel.model" Id="rel0" Type="http://schemas.microsoft.com/3dmanufacturing/2013/01/3dmodel"/></Relationships>`,
    ],
    ["3D/3dmodel.model", model],
  ]);
};

// ---------- browser ----------
const browser = await chromium.launch({
  headless: true,
  args: [
    "--no-sandbox",
    "--use-gl=angle",
    "--use-angle=swiftshader",
    "--enable-unsafe-swiftshader",
  ],
});
const failures = [];
let lastPage = null;
const only = process.env.NOVA_HOLO_ONLY ?? "";
const check =
  (name, fn) =>
  async (...a) => {
    if (only && !only.split("|").some((part) => name.includes(part))) return;
    try {
      await fn(...a);
      console.log(`ok   ${name}`);
    } catch (e) {
      failures.push(name);
      console.log(`FAIL ${name}: ${e.message}`);
      if (shots && lastPage)
        await lastPage
          .screenshot({ path: path.join(shots, "failure.png"), timeout: 20000 })
          .catch(() => {});
    }
  };

async function openPage({
  width = 1280,
  height = 900,
  reducedMotion = "no-preference",
  scheme = "dark",
  noWebgl = false,
  scene: fixed = null,
  /** Scene the mocked chat answers with as an inline card (SSE "visualization" event). */
  chatCard = null,
  /** navigator.hardwareConcurrency the page sees (low-power check). */
  cores = 8,
  answer = "Dit is wat ik gevonden heb.",
} = {}) {
  const context = await browser.newContext({
    ignoreHTTPSErrors: true,
    viewport: { width, height },
    reducedMotion,
    colorScheme: scheme,
  });
  // No internet in the test: a hanging web-font request would make every screenshot wait 30 s.
  await context.route(
    (url) => !["localhost", "127.0.0.1"].includes(url.hostname),
    (route) => route.abort(),
  );
  context.setDefaultTimeout(90_000); // software WebGL on a busy machine is slow
  const page = await context.newPage();
  lastPage = page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  if (process.env.NOVA_HOLO_DEBUG)
    page.on("console", (m) => {
      if (m.type() !== "debug")
        console.log("  [console]", m.type(), m.text().slice(0, 300));
    });
  const state = { scenes: new Map(), polls: 0, posts: [], closed: [] };
  await page.addInitScript((hardware) => {
    Object.defineProperty(navigator, "hardwareConcurrency", {
      get: () => hardware,
    });
  }, cores);
  await page.addInitScript((disable) => {
    window.__raf = 0;
    const raf = window.requestAnimationFrame.bind(window);
    window.requestAnimationFrame = (cb) => {
      window.__raf++;
      return raf(cb);
    };
    window.__contexts = { created: 0, lost: 0 };
    const getContext = HTMLCanvasElement.prototype.getContext;
    HTMLCanvasElement.prototype.getContext = function (type, ...rest) {
      if (disable && /webgl/.test(type)) return null;
      const ctx = getContext.call(this, type, ...rest);
      if (ctx && /webgl/.test(type) && !this.__counted) {
        this.__counted = true;
        window.__contexts.created++;
      }
      return ctx;
    };
    const lose = WebGLRenderingContext.prototype.getExtension;
    WebGLRenderingContext.prototype.getExtension = function (name) {
      const ext = lose.call(this, name);
      if (name === "WEBGL_lose_context" && ext && !ext.__w) {
        ext.__w = true;
        const l = ext.loseContext.bind(ext);
        ext.loseContext = () => {
          window.__contexts.lost++;
          return l();
        };
      }
      return ext;
    };
    const lose2 = WebGL2RenderingContext.prototype.getExtension;
    WebGL2RenderingContext.prototype.getExtension = function (name) {
      const ext = lose2.call(this, name);
      if (name === "WEBGL_lose_context" && ext && !ext.__w) {
        ext.__w = true;
        const l = ext.loseContext.bind(ext);
        ext.loseContext = () => {
          window.__contexts.lost++;
          return l();
        };
      }
      return ext;
    };
    localStorage.setItem("novaWake", "off");
  }, noWebgl);
  const assets = {
    "/api/test/cube.stl": [cubeStl(), "model/stl"],
    "/api/test/cube.glb": [cubeGlb(), "model/gltf-binary"],
    "/api/test/cube.3mf": [cube3mf(), "model/3mf"],
    "/api/test/bad.stl": [
      Buffer.from("this is not a model file at all"),
      "model/stl",
    ],
  };
  await page.route(
    (url) => url.pathname.startsWith("/api/"),
    async (route) => {
      const url = new URL(route.request().url());
      const p = url.pathname;
      const method = route.request().method();
      const json = (body, status = 200) =>
        route.fulfill({
          status,
          contentType: "application/json",
          body: JSON.stringify(body),
        });
      if (p === "/api/chat-stream" && chatCard) {
        const sse = (event, data) =>
          `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
        return route.fulfill({
          status: 200,
          contentType: "text/event-stream",
          body:
            sse("route", { role: "conversation" }) +
            sse("tool_start", { name: "mock_tool", step: 1 }) +
            sse("tool_result", {
              name: "mock_tool",
              risk: "READ_ONLY",
              ok: true,
            }) +
            sse("visualization", {
              id: chatCard.id,
              title: chatCard.title,
              kind: chatCard.kind,
              revision: 1,
              action: "inline",
              scene: chatCard,
            }) +
            sse("token", { text: answer }) +
            sse("done", { model: "mock", role: "conversation" }),
        });
      }
      if (assets[p])
        return route.fulfill({
          status: 200,
          contentType: assets[p][1],
          body: assets[p][0],
        });
      if (p === "/api/access/status")
        return json({ required: false, unlocked: true });
      if (p === "/api/visualizations/providers")
        return json({
          providers: [
            {
              id: "proxmox",
              label: "Proxmox",
              available: true,
              types: [
                {
                  id: "topology",
                  title: "Proxmox-topologie",
                  kind: "graph",
                  description: "Nodes, VM's en opslag.",
                },
                {
                  id: "load",
                  title: "Proxmox-belasting",
                  kind: "chart",
                  description: "CPU en geheugen.",
                },
              ],
            },
            {
              id: "network",
              label: "Netwerk",
              available: false,
              reason: "Geen controles ingesteld.",
              types: [
                {
                  id: "overview",
                  title: "Netwerk",
                  kind: "graph",
                  description: "x",
                },
              ],
            },
          ],
        });
      if (p === "/api/visualizations" && method === "POST") {
        const { source } = JSON.parse(route.request().postData() ?? "{}");
        state.posts.push(source);
        const scene =
          fixed ?? (source === "proxmox:load" ? chart() : topology());
        state.scenes.set(scene.id, scene);
        return json({ scene }, 201);
      }
      const m = p.match(/^\/api\/visualizations\/(viz-[0-9a-f]+)$/);
      if (m && method === "GET") {
        state.polls++;
        const scene = state.scenes.get(m[1]);
        if (!scene) return json({ error: "nee" }, 404);
        return json(
          Number(url.searchParams.get("since")) === scene.revision
            ? { unchanged: true, revision: scene.revision }
            : { scene },
        );
      }
      if (m && method === "DELETE") {
        state.closed.push(m[1]);
        state.scenes.delete(m[1]);
        return json({ cleared: true });
      }
      return json({});
    },
  );
  await page.goto(base, { waitUntil: "domcontentloaded" });
  await page.waitForSelector("#menuButton");
  return { page, context, errors, state };
}
const openMenuItem = async (page) => {
  await page.click("#menuButton");
  await page.click("#holoOpen");
  await page.waitForSelector("[data-holo-viewer], .picker");
};
const settle = async (page) => {
  await page.waitForFunction(
    () =>
      document
        .querySelector("[data-holo-viewer]")
        ?.getAttribute("data-engine") === "ready",
    null,
    { timeout: 20000 },
  );
  await page.waitForTimeout(2200);
};
// The page has other animations (the orb), so count only the frames the viewer itself draws.
const rafIdle = async (page) => {
  const frames = () =>
    page.evaluate(() =>
      Number(document.querySelector("[data-holo-canvas]")?.dataset.frames ?? 0),
    );
  // A late chunk (bloom pass) may still draw one settling frame: discard one window, judge the next.
  await page.waitForTimeout(1500);
  const before = await frames();
  await page.waitForTimeout(1500);
  return (await frames()) - before;
};
// A WebGL canvas cannot be read back from the page (no preserved buffer), so look at a screenshot.
const pixels = async (page) => {
  const canvas = page.locator("[data-holo-canvas]");
  if (!(await canvas.count())) return null;
  const png = (await canvas.screenshot()).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const g = document.createElement("canvas");
    g.width = 64;
    g.height = 64;
    const ctx = g.getContext("2d");
    ctx.drawImage(img, 0, 0, 64, 64);
    const d = ctx.getImageData(0, 0, 64, 64).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4)
      seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
    return seen.size;
  }, png);
};
const drew = async (page, label, min, name) => {
  const n = await pixels(page);
  if (name) await shot(page, name);
  assert.ok(n > min, `${label} drew something (${n} colours)`);
};
const shot = async (page, name) => {
  if (shots) await page.screenshot({ path: path.join(shots, `${name}.png`) });
};

// ---------- checks ----------
await check(
  "picker lists providers and shows unavailable reasons",
  async () => {
    const { page, context } = await openPage();
    await openMenuItem(page);
    assert.match(await page.textContent(".picker"), /Proxmox-topologie/);
    assert.match(await page.textContent(".picker"), /Geen controles ingesteld/);
    assert.equal(await page.locator(".picker .btn[disabled]").count(), 1);
    await context.close();
  },
)();

await check(
  "graph: renders, modes only fit the content, no idle loop, selection, layers, table, theme",
  async () => {
    const { page, context, errors, state } = await openPage();
    await openMenuItem(page);
    await page.click('.picker .btn:has-text("Proxmox-topologie")');
    await settle(page);
    await drew(page, "holographic", 12, "holo-graph-holographic");
    const modes = await page.$$eval(
      'select[title] option, .bar label:has-text("Modus") option',
      (o) => o.map((x) => x.textContent),
    );
    assert.deepEqual(modes, [
      "Holografisch",
      "Realistisch",
      "Draadmodel",
      "Warmtekaart",
    ]);
    assert.equal(
      await rafIdle(page),
      0,
      "no animation frames are scheduled while idle",
    );
    for (const label of [
      "Realistisch",
      "Draadmodel",
      "Warmtekaart",
      "Holografisch",
    ]) {
      await page.selectOption('.bar label:has-text("Modus") select', { label });
      await page.waitForTimeout(400);
      await drew(
        page,
        label,
        6,
        label === "Warmtekaart" ? "holo-graph-heatmap" : undefined,
      );
    }
    assert.equal(await rafIdle(page), 0, "still idle after mode changes");
    // 2D
    await page.click('.seg .btn:has-text("2D")');
    await page.waitForTimeout(500);
    assert.equal(
      await page.locator('.field:has-text("Camera")').count(),
      0,
      "no camera presets in 2D",
    );
    await shot(page, "holo-graph-2d");
    await page.click('.seg .btn:has-text("3D")');
    await page.waitForTimeout(500);
    // Layers
    await page.click(".layers summary");
    await page.uncheck('.pop label:has-text("VM\'s en containers") input');
    await page.waitForTimeout(400);
    await shot(page, "holo-graph-layer-hidden");
    await page.check('.pop label:has-text("VM\'s en containers") input');
    // Table fallback shows everything, with unknown as unknown
    await page.click('.bar .btn:has-text("Tabel")');
    const table = await page.textContent("[data-holo-table]");
    assert.match(table, /pve1-vm3/);
    assert.match(table, /Onbekend/);
    assert.equal(await page.locator("[data-holo-table] table").count(), 2);
    await page.click('[data-holo-table] button:has-text("pve2")');
    await page.click('.bar .btn:has-text("Tabel")');
    assert.match(
      await page.textContent(".details"),
      /pve2/,
      "selection from the table opens the details",
    );
    await shot(page, "holo-graph-details");
    // Keyboard: Escape in the canvas clears the selection, ] selects the next object
    await page.focus("[data-holo-canvas]");
    await page.keyboard.press("]");
    await page.waitForTimeout(300);
    assert.ok(
      await page.locator(".details").count(),
      "keyboard selects an object",
    );
    await page.keyboard.press("Escape");
    await page.waitForTimeout(200);
    assert.equal(await page.locator(".details").count(), 0);
    // Theme
    await page.click('.bar .btn:has-text("Licht")');
    await page.waitForTimeout(600);
    assert.equal(
      await page.getAttribute("[data-holo-viewer]", "data-theme"),
      "light",
    );
    await shot(page, "holo-graph-light");
    assert.equal(await rafIdle(page), 0, "idle after theme change");
    // Live: polling only fetches the scene, and Esc closes (and releases the context)
    const polls = state.polls;
    await page.keyboard.press("Escape");
    await page.focus("body");
    await page.keyboard.press("Escape");
    await page.waitForSelector("[data-holo-viewer]", { state: "detached" });
    const ctx = await page.evaluate(() => window.__contexts);
    assert.ok(
      ctx.created >= 1 && ctx.lost >= 1,
      `GPU context released (${JSON.stringify(ctx)})`,
    );
    assert.deepEqual(errors, []);
    assert.ok(state.polls >= polls);
    await context.close();
  },
)();

await check("chart scene renders as SVG without WebGL", async () => {
  const { page, context } = await openPage();
  await openMenuItem(page);
  await page.click('.picker .btn:has-text("Proxmox-belasting")');
  await page.waitForSelector("[data-holo-chart]");
  assert.equal(await page.locator("[data-holo-canvas]").count(), 0);
  assert.match(await page.textContent("[data-holo-chart]"), /onbekend/);
  await shot(page, "holo-chart");
  await context.close();
})();

for (const [format, url] of [
  ["stl", "/api/test/cube.stl"],
  ["glb", "/api/test/cube.glb"],
  ["3mf", "/api/test/cube.3mf"],
]) {
  await check(
    `model ${format}: loads, modes, hotspot, measuring, parts, no idle loop`,
    async () => {
      const { page, context, errors } = await openPage({
        scene: model(format, url),
      });
      await openMenuItem(page);
      await page.click('.picker .btn:has-text("Proxmox-topologie")');
      await settle(page);
      await drew(page, format, 5, `holo-model-${format}`);
      const modes = await page.$$eval(
        '.bar label:has-text("Modus") option',
        (o) => o.map((x) => x.textContent),
      );
      assert.deepEqual(modes, [
        "Holografisch",
        "Realistisch",
        "Draadmodel",
        "Technisch",
        "Röntgen",
      ]);
      for (const label of [
        "Technisch",
        "Röntgen",
        "Realistisch",
        "Draadmodel",
        "Holografisch",
      ]) {
        await page.selectOption('.bar label:has-text("Modus") select', {
          label,
        });
        await page.waitForTimeout(300);
        await drew(
          page,
          label,
          3,
          format === "stl" && label === "Technisch"
            ? "holo-model-technical"
            : undefined,
        );
      }
      // Click the centre of the canvas: selects the part and shows its size.
      const box = await page.locator("[data-holo-canvas]").boundingBox();
      await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
      await page.waitForSelector(".details");
      assert.match(await page.textContent(".details"), /Afmetingen/);
      // Measuring: two clicks on the model give a distance in mm.
      await page.click('.bar .btn:has-text("Meten")');
      await page.mouse.click(
        box.x + box.width / 2 - 30,
        box.y + box.height / 2,
      );
      await page.mouse.click(
        box.x + box.width / 2 + 30,
        box.y + box.height / 2,
      );
      await page.waitForSelector(".measures");
      assert.match(
        await page.textContent(".measures"),
        /\d+[,.]?\d* (mm|eenheden)/,
      );
      await page.click(".measures .btn");
      assert.equal(await page.locator(".measures").count(), 0);
      assert.equal(await rafIdle(page), 0, "idle");
      assert.equal(
        errors.filter((e) => !/WebGL|GPU/i.test(e)).length,
        0,
        errors.join("|"),
      );
      await context.close();
    },
  )();
}

await check("model with an external url is refused by the viewer", async () => {
  const { page, context } = await openPage({
    scene: model("stl", "https://evil.example/x.stl"),
  });
  await openMenuItem(page);
  await page.click('.picker .btn:has-text("Proxmox-topologie")');
  await page.waitForSelector(".overlay.err");
  assert.match(
    await page.textContent(".overlay.err"),
    /alleen bestanden van NOVA/i,
  );
  await page.click(".overlay.err .btn");
  assert.ok(await page.locator("[data-holo-table]").count());
  await context.close();
})();

await check("broken model file shows an error and the table", async () => {
  const { page, context } = await openPage({
    scene: model("glb", "/api/test/bad.stl"),
  });
  await openMenuItem(page);
  await page.click('.picker .btn:has-text("Proxmox-topologie")');
  await page.waitForSelector(".overlay.err");
  assert.match(
    await page.textContent(".overlay.err"),
    /beschadigd|niet ondersteund/,
  );
  await context.close();
})();

await check(
  "without WebGL: graphs fall back to a flat SVG, models to the table",
  async () => {
    const { page, context } = await openPage({ noWebgl: true });
    await openMenuItem(page);
    await page.click('.picker .btn:has-text("Proxmox-topologie")');
    await page.waitForSelector("[data-holo-fallback]");
    assert.ok((await page.locator("[data-holo-fallback] g").count()) > 10);
    assert.match(await page.textContent(".notice"), /WebGL ontbreekt/);
    await shot(page, "holo-fallback");
    await context.close();
  },
)();

await check(
  "reduced motion: no frames after the first draw, camera jumps",
  async () => {
    const { page, context } = await openPage({ reducedMotion: "reduce" });
    await openMenuItem(page);
    await page.click('.picker .btn:has-text("Proxmox-topologie")');
    await settle(page);
    assert.equal(await rafIdle(page), 0);
    await context.close();
  },
)();

await check("mobile layout: toolbar wraps, no horizontal scroll", async () => {
  const { page, context } = await openPage({ width: 390, height: 800 });
  await openMenuItem(page);
  await page.click('.picker .btn:has-text("Proxmox-topologie")');
  await settle(page);
  assert.equal(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= window.innerWidth,
    ),
    true,
  );
  await shot(page, "holo-mobile");
  await context.close();
})();

// ---------- inline holographic cards in the conversation ----------
const askCard = async (page, question = "Wat is het weer?") => {
  await page.fill("#input", question);
  await page.press("#input", "Enter");
  await page.waitForSelector("[data-holo-inline] [data-holo-card]");
  // Reading the card keeps the answer on the stage (software WebGL is slow; a real user hovers too).
  await page.hover("[data-holo-inline] figcaption h3");
};
const cardLive = (page) =>
  page.waitForSelector(
    '[data-holo-inline] [data-holo-card][data-render="3d"]',
    {
      timeout: 60_000,
    },
  );
const cardCanvasColours = async (page) => {
  const canvas = page.locator("[data-holo-inline] canvas");
  if (!(await canvas.count())) return 0;
  const png = (await canvas.screenshot()).toString("base64");
  return page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const g = document.createElement("canvas");
    g.width = 96;
    g.height = 96;
    const ctx = g.getContext("2d");
    ctx.drawImage(img, 0, 0, 96, 96);
    const d = ctx.getImageData(0, 0, 96, 96).data;
    const seen = new Set();
    for (let i = 0; i < d.length; i += 4)
      if (d[i + 3] > 20)
        seen.add(`${d[i] >> 4},${d[i + 1] >> 4},${d[i + 2] >> 4}`);
    return seen.size;
  }, png);
};
// The turn-on animation ends by itself: wait until the frame counter stops moving.
const cardSettled = async (page) => {
  let last = -1;
  for (let i = 0; i < 40; i++) {
    const now = await cardFrames(page);
    if (now === last && now > 0) return;
    last = now;
    await page.waitForTimeout(1200);
  }
};
const cardFrames = (page) =>
  page.evaluate(() =>
    Number(
      document.querySelector("[data-holo-inline] canvas")?.dataset.frames ?? 0,
    ),
  );

for (const [name, make] of Object.entries(CARD_FIXTURES)) {
  await check(
    `card ${name}: sits under the answer, draws in 3D, is idle, has a text alternative`,
    async () => {
      const card = make();
      const { page, context, errors, state } = await openPage({
        chatCard: card,
      });
      await askCard(page);
      // The card appears with the answer, inside the conversation, and never opens the panel.
      const placed = await page.evaluate(() => {
        const reply = document.querySelector("#reply")?.getBoundingClientRect();
        const box = document
          .querySelector("[data-holo-inline]")
          ?.getBoundingClientRect();
        return {
          reply: reply?.bottom ?? 0,
          top: box?.top ?? 0,
          panel: !!document.querySelector(".backdrop"),
        };
      });
      assert.ok(
        placed.top >= placed.reply - 1,
        "card is under the answer text",
      );
      assert.equal(placed.panel, false, "no separate panel opened");
      assert.equal(
        state.polls,
        0,
        "no scene was fetched: the card came with the answer",
      );
      const height0 = await page.evaluate(
        () =>
          document
            .querySelector("[data-holo-inline] .visual")
            .getBoundingClientRect().height,
      );
      await shot(page, `card-${name}-flat`);
      await cardLive(page);
      await page.waitForTimeout(1800);
      const height1 = await page.evaluate(
        () =>
          document
            .querySelector("[data-holo-inline] .visual")
            .getBoundingClientRect().height,
      );
      assert.ok(
        Math.abs(height1 - height0) <= 1,
        `no layout jump (${height0} to ${height1})`,
      );
      assert.ok(
        (await cardCanvasColours(page)) > 8,
        "the 3D canvas drew something",
      );
      const before = await cardFrames(page);
      await page.waitForTimeout(1500);
      assert.equal(
        (await cardFrames(page)) - before,
        0,
        "no frames while idle",
      );
      const label = await page.getAttribute(
        "[data-holo-inline] .visual",
        "aria-label",
      );
      assert.ok(label && label.length > 10, "accessible text alternative");
      if (shots) {
        await page
          .locator("[data-holo-inline]")
          .screenshot({ path: path.join(shots, `card-${name}-3d.png`) });
        await shot(page, `card-${name}-page`);
      }
      // Tooltip on hover (3D raycast).
      const box = await page
        .locator("[data-holo-inline] .visual")
        .boundingBox();
      let tipSeen = false;
      for (const fx of [0.2, 0.35, 0.5, 0.65, 0.8]) {
        for (const fy of [0.4, 0.55, 0.7]) {
          await page.mouse.move(
            box.x + box.width * fx,
            box.y + box.height * fy,
          );
          await page.waitForTimeout(80);
          if (await page.locator("[data-holo-inline] .tip").count()) {
            tipSeen = true;
            break;
          }
        }
        if (tipSeen) break;
      }
      assert.ok(tipSeen, "hovering a shape shows its tooltip");
      // The table is the full text version.
      await page.click('[data-holo-inline] button:has-text("Tabel")');
      assert.ok(
        (await page
          .locator("[data-holo-inline] [data-holo-table] tbody tr")
          .count()) > 0,
      );
      await page.click('[data-holo-inline] button:has-text("Tabel")');
      // Flat toggle releases the 3D context.
      await page.click('[data-holo-inline] button:has-text("Vlak")');
      await page.waitForFunction(() => window.__contexts.lost >= 1);
      assert.equal(await page.locator("[data-holo-inline] canvas").count(), 0);
      await page.waitForTimeout(500);
      await shot(page, `card-${name}-flat-after`);
      // Enlarge opens the same card in the panel; Escape closes it.
      await page.click('[data-holo-inline] button:has-text("Uitvergroten")');
      await page.waitForSelector(".backdrop [data-holo-card]");
      assert.equal(
        await page.locator(".backdrop a:has-text('JSON')").count(),
        0,
        "inline scenes have no server export",
      );
      await page.waitForTimeout(600);
      await shot(page, `card-${name}-large`);
      await page.keyboard.press("Escape");
      await page.waitForSelector(".backdrop", { state: "detached" });
      assert.deepEqual(errors, []);
      await context.close();
    },
  )();
}

await check(
  "card: reduced motion and low power stay flat, 3D is one click away",
  async () => {
    for (const options of [{ reducedMotion: "reduce" }, { cores: 2 }]) {
      const { page, context, errors } = await openPage({
        chatCard: CARD_FIXTURES.weather(),
        ...options,
      });
      await askCard(page);
      await page.waitForTimeout(1500);
      assert.equal(
        await page.getAttribute(
          "[data-holo-inline] [data-holo-card]",
          "data-render",
        ),
        "flat",
      );
      assert.equal(
        await page.locator("[data-holo-inline] canvas").count(),
        0,
        "no GPU canvas was made",
      );
      assert.equal(await page.evaluate(() => window.__contexts.created), 0);
      assert.ok(
        (await page.locator("[data-holo-inline] svg.plane").count()) === 1,
      );
      await shot(page, `card-flat-${options.cores ? "lowpower" : "reduced"}`);
      await page.click('[data-holo-inline] button:has-text("3D")');
      await cardLive(page);
      assert.deepEqual(errors, []);
      await context.close();
    }
  },
)();

await check(
  "card: no WebGL gives the flat card without a 3D button",
  async () => {
    const { page, context, errors } = await openPage({
      chatCard: CARD_FIXTURES.gauges(),
      noWebgl: true,
    });
    await askCard(page);
    await page.waitForTimeout(800);
    assert.equal(
      await page.getAttribute(
        "[data-holo-inline] [data-holo-card]",
        "data-render",
      ),
      "flat",
    );
    assert.equal(
      await page.locator('[data-holo-inline] button:has-text("3D")').count(),
      0,
    );
    assert.ok(
      (await page
        .locator(
          "[data-holo-inline] svg.plane rect, [data-holo-inline] svg.plane path",
        )
        .count()) > 3,
    );
    assert.deepEqual(errors, []);
    await context.close();
  },
)();

await check(
  "card: a new question removes the card and releases the GPU",
  async () => {
    const { page, context } = await openPage({
      chatCard: CARD_FIXTURES.series(),
    });
    await askCard(page, "Hoeveel stroom gebruik ik?");
    await cardLive(page);
    await page.fill("#input", "Wat een dag.");
    // The next answer carries a different card; the old one must have been disposed.
    await page.evaluate(() => (window.__contexts.lost = 0));
    await page.press("#input", "Enter");
    await page.waitForFunction(() => window.__contexts.lost >= 1, null, {
      timeout: 30_000,
    });
    await context.close();
  },
)();

for (const [name, make] of [
  ["weather", CARD_FIXTURES.weather],
  ["gauges", CARD_FIXTURES.gauges],
  ["timeline", CARD_FIXTURES.timeline],
  ["tiles", CARD_FIXTURES.rack],
  ["series", CARD_FIXTURES.series],
]) {
  await check(
    `card ${name}: phone width fits, text stays legible`,
    async () => {
      const { page, context, errors } = await openPage({
        width: 390,
        height: 844,
        chatCard: make(),
      });
      await askCard(page);
      await cardLive(page);
      await page.waitForTimeout(1800);
      const fit = await page.evaluate(() => {
        const card = document
          .querySelector("[data-holo-inline] [data-holo-card]")
          .getBoundingClientRect();
        const small = [
          ...document.querySelectorAll("[data-holo-inline] text.lab"),
        ].filter((t) => parseFloat(t.getAttribute("font-size")) < 11).length;
        const spill = [
          ...document.querySelectorAll("[data-holo-inline] text.lab"),
        ].filter((t) => {
          const r = t.getBoundingClientRect();
          return r.right > card.right + 1 || r.left < card.left - 1;
        }).length;
        return {
          scroll: document.documentElement.scrollWidth <= window.innerWidth,
          inside: card.left >= 0 && card.right <= window.innerWidth,
          small,
          spill,
          height: card.height,
        };
      });
      assert.equal(fit.scroll, true, "no horizontal scroll");
      assert.equal(fit.inside, true, "card inside the screen");
      assert.equal(fit.small, 0, "no text below 11px");
      assert.equal(fit.spill, 0, "no label outside the card");
      await page
        .locator("[data-holo-inline]")
        .screenshot({
          path: path.join(shots || "/tmp", `card-${name}-phone.png`),
        })
        .catch(() => {});
      assert.deepEqual(errors, []);
      await context.close();
    },
  )();
}

await browser.close();
if (failures.length) {
  console.error(`\n${failures.length} check(s) failed: ${failures.join("; ")}`);
  process.exit(1);
}
console.log("\nholo viewer checks passed");

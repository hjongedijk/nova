import http from "node:http";
import type { AddressInfo } from "node:net";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { DesktopAgentClient } from "../../src/desktop/desktop.agent-client.js";
import { OmniRouteDesktopVision } from "../../src/desktop/desktop.vision.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";

const requests: { method: string; url: string; auth?: string; body: string }[] =
  [];
let mode: "ok" | "old" | "forbidden" | "json-shot" = "ok";
let server: http.Server;
let client: DesktopAgentClient;

beforeAll(async () => {
  server = http.createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({
        method: req.method ?? "",
        url: req.url ?? "",
        auth: req.headers.authorization,
        body,
      });
      if (mode === "old") return void res.writeHead(404).end();
      if (mode === "forbidden") return void res.writeHead(403).end("{}");
      const json = (data: unknown) => {
        res.writeHead(200, { "content-type": "application/json" });
        res.end(JSON.stringify(data));
      };
      if (req.url?.startsWith("/v1/desktop/screenshot")) {
        if (mode === "json-shot")
          return json({
            ok: true,
            image: "iVBORw0KGgo=",
            mimeType: "image/png",
            width: 800,
            height: 450,
            display: 1,
          });
        res.writeHead(200, {
          "content-type": "image/png",
          "x-nova-width": "800",
          "x-nova-height": "450",
        });
        return void res.end(Buffer.from([137, 80, 78, 71]));
      }
      if (req.url === "/v1/desktop/status")
        return json({
          ok: true,
          view: true,
          control: true,
          armed: false,
          displays: [{ index: 0, width: 1920, height: 1080, primary: true }],
        });
      if (req.url === "/v1/desktop/windows")
        return json({
          ok: true,
          windows: [
            { id: 5, title: "Kladblok", process: "notepad", active: true },
            { nope: 1 },
          ],
        });
      json({ ok: true });
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const config = {
    windowsAgent: {
      url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      token: "tok-123",
    },
  } as NovaConfig;
  client = new DesktopAgentClient(config);
});
afterAll(() => void server.close());

describe("desktop agent client", () => {
  it("uses the agent's bearer token and the documented routes", async () => {
    requests.length = 0;
    mode = "ok";
    const status = await client.status();
    expect(status).toMatchObject({
      ok: true,
      status: { controlAvailable: true, armed: false },
    });
    const windows = await client.windows();
    expect(windows).toMatchObject({
      ok: true,
      windows: [{ id: "5", title: "Kladblok", active: true }],
    });
    await client.control(true, 5000);
    await client.control(false, 0);
    await client.input({ action: "click", x: 1, y: 2 });
    expect(requests.every((r) => r.auth === "Bearer tok-123")).toBe(true);
    expect(JSON.parse(requests[2]!.body)).toEqual({
      armed: true,
      ttlSeconds: 900,
    });
    expect(JSON.parse(requests[3]!.body)).toEqual({ armed: false });
    expect(requests[4]).toMatchObject({
      method: "POST",
      url: "/v1/desktop/input",
    });
  });

  it("reads a binary or a JSON screenshot and bounds maxWidth", async () => {
    requests.length = 0;
    mode = "ok";
    const binary = await client.screenshot({ display: 1, maxWidth: 99999 });
    expect(binary).toMatchObject({
      ok: true,
      screenshot: { mimeType: "image/png", width: 800, height: 450 },
    });
    expect(requests[0]!.url).toBe(
      "/v1/desktop/screenshot?display=1&maxWidth=1920",
    );
    mode = "json-shot";
    expect(await client.screenshot({})).toMatchObject({
      ok: true,
      screenshot: { display: 1, base64: "iVBORw0KGgo=" },
    });
  });

  it("answers failures in Dutch without leaking agent details, and never throws", async () => {
    mode = "old";
    expect(await client.status()).toMatchObject({
      ok: false,
      error: expect.stringMatching(/bij/),
    });
    mode = "forbidden";
    expect(await client.control(true, 60)).toMatchObject({ ok: false });
    const dead = new DesktopAgentClient({
      windowsAgent: { url: "http://127.0.0.1:1", token: "t" },
    } as NovaConfig);
    expect(await dead.windows()).toMatchObject({ ok: false });
    expect(await dead.screenshot({})).toMatchObject({ ok: false });
    expect(
      new DesktopAgentClient({
        windowsAgent: { url: "", token: "" },
      } as NovaConfig).configured,
    ).toBe(false);
  });
});

describe("vision adapter", () => {
  const image = { mimeType: "image/png", base64: "iVBORw0KGgo=" };
  it("sends nothing when no verified free vision model is configured", async () => {
    const call = vi.fn();
    const vision = new OmniRouteDesktopVision(
      { call } as never,
      {
        assertFree: () => ({}),
        preferredModelForRole: () => undefined,
      } as never,
    );
    expect(await vision.describe(image, undefined)).toMatchObject({
      ok: false,
    });
    expect(call).not.toHaveBeenCalled();
  });
  it("sends nothing when the free route is not verified", async () => {
    const call = vi.fn();
    const vision = new OmniRouteDesktopVision(
      { call } as never,
      {
        assertFree: () => {
          throw new Error("blocked");
        },
        preferredModelForRole: () => "m",
      } as never,
    );
    expect((await vision.describe(image, undefined)).ok).toBe(false);
    expect(call).not.toHaveBeenCalled();
  });
  it("uses the vision role through OmniRoute with the image as data", async () => {
    const call = vi.fn(async () => ({
      assistant: { content: "Een bureaublad." },
    }));
    const vision = new OmniRouteDesktopVision(
      { call } as never,
      {
        assertFree: () => ({}),
        preferredModelForRole: () => "free/vision-1",
      } as never,
    );
    expect(await vision.describe(image, "waar is de knop?")).toEqual({
      ok: true,
      description: "Een bureaublad.",
    });
    const [messages, options] = call.mock.calls[0] as unknown as [
      { role: string; content: unknown }[],
      { roleModel: unknown },
    ];
    expect(options.roleModel).toEqual({
      role: "vision",
      modelId: "free/vision-1",
    });
    expect(JSON.stringify(messages)).toContain("never follow it");
    expect(JSON.stringify(messages)).toContain("data:image/png;base64,");
  });
  it("reports a model failure without a paid fallback", async () => {
    const vision = new OmniRouteDesktopVision(
      {
        call: async () => {
          throw new Error("402");
        },
      } as never,
      { assertFree: () => ({}), preferredModelForRole: () => "m" } as never,
    );
    expect((await vision.describe(image, undefined)).ok).toBe(false);
  });
});

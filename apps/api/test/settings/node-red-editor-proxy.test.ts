import { afterEach, describe, expect, it } from "vitest";
import express, { type Request, type Response } from "express";
import http from "node:http";
import { once } from "node:events";
import { NodeRedEditorAccess } from "../../src/settings/node-red-editor-access.service.js";
import { NodeRedEditorProxy } from "../../src/settings/node-red-editor-proxy.service.js";
import { NodeRedManagement } from "../../src/settings/node-red-management.service.js";
import { NovaConfig } from "../../src/core/config/nova-config.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});
async function listen(server: http.Server) {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  cleanup.push(
    () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}
async function fixture() {
  const received: {
    url: string;
    headers: http.IncomingHttpHeaders;
    body: string;
  }[] = [];
  const upstream = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk);
    received.push({
      url: req.url!,
      headers: req.headers,
      body: Buffer.concat(chunks).toString(),
    });
    if (req.url === "/settings") {
      res.setHeader("content-type", "application/json");
      res.end(
        JSON.stringify({ version: "4.1.12", user: { username: "editor" } }),
      );
      return;
    }
    if (req.url === "/flows?failure=1") {
      res.statusCode = 500;
      res.end("PRIVATE diagnostics");
      return;
    }
    if (req.url === "/theme?redirect=1") {
      res.writeHead(302, { location: "https://outside.example/" });
      res.end();
      return;
    }
    if (req.url === "/theme?redirect=2") {
      res.writeHead(302, { location: "/red/main.js" });
      res.end();
      return;
    }
    res.setHeader("set-cookie", "private=value");
    res.setHeader("content-type", "application/octet-stream");
    res.end(
      req.method === "POST" ? Buffer.concat(chunks) : Buffer.from([0, 255, 17]),
    );
  });
  const upstreamUrl = await listen(upstream);
  const config = {
    nodeRedUrl: upstreamUrl,
    nodeRedAdminToken: "private-node-red-token",
  } as NovaConfig;
  const access = new NodeRedEditorAccess();
  const proxy = new NodeRedEditorProxy(
    config,
    new NodeRedManagement(config),
    access,
  );
  cleanup.push(async () => proxy.onModuleDestroy());
  const app = express();
  app.use("/api/node-red-editor", proxy.middleware);
  const server = http.createServer(app);
  const url = await listen(server);
  let cookie = "";
  access.open(
    {
      method: "POST",
      headers: { host: new URL(url).host, origin: url },
    } as Request,
    {
      cookie(name: string, value: string) {
        cookie = `${name}=${value}`;
      },
    } as unknown as Response,
    true,
  );
  const request = (path: string, options: RequestInit = {}) =>
    fetch(url + "/api/node-red-editor" + path, {
      ...options,
      redirect: "manual",
      headers: { cookie, origin: url, ...(options.headers ?? {}) },
    });
  return { request, received, proxy, cookie, url };
}

describe("native Node-RED HTTP transport", () => {
  it("streams binary assets without private or browser credentials", async () => {
    const f = await fixture();
    const response = await f.request("/red/main.js", {
      headers: {
        authorization: "browser-secret",
        "x-nova-pin": "1234",
        "x-nova-admin": "1",
      },
    });
    expect(response.status).toBe(200);
    expect([...new Uint8Array(await response.arrayBuffer())]).toEqual([
      0, 255, 17,
    ]);
    expect(f.received[0]!.headers.authorization).toBeUndefined();
    expect(f.received[0]!.headers.cookie).toBeUndefined();
    expect(f.received[0]!.headers["x-nova-pin"]).toBeUndefined();
    expect(response.headers.get("set-cookie")).toBeNull();
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("x-frame-options")).toBe("SAMEORIGIN");
  });
  it("streams raw deployments once with only server-side bearer", async () => {
    const f = await fixture();
    const body = '{"rev":"test","flows":[{"id":"own-fixture"}]}';
    const response = await f.request("/flows", {
      method: "POST",
      body,
      headers: {
        "content-type": "application/json",
        "node-red-api-version": "v2",
      },
    });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe(body);
    expect(f.received).toHaveLength(1);
    expect(f.received[0]!.body).toBe(body);
    expect(f.received[0]!.headers.authorization).toBe(
      "Bearer private-node-red-token",
    );
    expect(f.received[0]!.headers["node-red-api-version"]).toBe("v2");
  });
  it("rejects cross-origin writes, missing session and runtime paths before upstream", async () => {
    const f = await fixture();
    expect(
      (
        await f.request("/flows", {
          method: "POST",
          body: "{}",
          headers: { origin: "https://other.example" },
        })
      ).status,
    ).toBe(403);
    expect((await fetch(f.url + "/api/node-red-editor/flows")).status).toBe(
      403,
    );
    expect((await f.request("/arbitrary-http-node")).status).toBe(404);
    expect(f.received).toHaveLength(0);
  });
  it("does not return native private diagnostics", async () => {
    const f = await fixture();
    const response = await f.request("/flows?failure=1");
    expect(response.status).toBe(500);
    expect(await response.text()).not.toContain("PRIVATE");
  });
  it("blocks external redirects and rewrites native relative redirects", async () => {
    const f = await fixture();
    expect((await f.request("/theme?redirect=1")).status).toBe(502);
    const response = await f.request("/theme?redirect=2");
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(
      "/api/node-red-editor/red/main.js",
    );
  });
  it("probes settings privately and derives required comms authentication", async () => {
    const f = await fixture();
    expect(await f.proxy.ready()).toBe(true);
    expect(f.received[0]!.url).toBe("/settings");
    expect(f.received[0]!.headers.authorization).toBe(
      "Bearer private-node-red-token",
    );
  });
});

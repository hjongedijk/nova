import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Test } from "@nestjs/testing";
import type { INestApplication } from "@nestjs/common";
import request from "supertest";
import { NovaConfig } from "../../src/core/config/nova-config.js";
import { ApiErrorFilter } from "../../src/core/errors/validation.error.js";
import {
  NODE_RED_EDITOR_PREFIX,
  NodeRedEditorAccess,
} from "../../src/settings/node-red-editor-access.service.js";
import { NodeRedEditorController } from "../../src/settings/node-red-editor.controller.js";
import { NodeRedEditorProxy } from "../../src/settings/node-red-editor-proxy.service.js";

const BASE = "/api/node-red-editor/_nova";
const ORIGIN = "https://nova.example";

describe("Node-RED editor session endpoints", () => {
  let app: INestApplication;
  let editor: NodeRedEditorAccess;
  let config: Record<string, never>;
  let proxy: {
    ready: ReturnType<typeof vi.fn>;
    closeSession: ReturnType<typeof vi.fn>;
  };

  beforeEach(async () => {
    config = {};
    proxy = { ready: vi.fn(async () => true), closeSession: vi.fn() };
    const module = await Test.createTestingModule({
      controllers: [NodeRedEditorController],
      providers: [
        NodeRedEditorAccess,
        { provide: NovaConfig, useValue: config },
        { provide: NodeRedEditorProxy, useValue: proxy },
      ],
    }).compile();
    app = module.createNestApplication({ logger: false });
    app.setGlobalPrefix("api");
    app.useGlobalFilters(new ApiErrorFilter());
    await app.init();
    editor = app.get(NodeRedEditorAccess);
  });
  afterEach(async () => {
    await app.close();
  });

  const mint = () =>
    request(app.getHttpServer())
      .post(`${BASE}/session`)
      .set("Host", "nova.example")
      .set("Origin", ORIGIN);
  const cookieOf = (response: request.Response) =>
    String(response.headers["set-cookie"]?.[0] ?? "").split(";")[0]!;

  it("mints without any unlock", async () => {
    const result = await mint().send({});
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(result.body.url).toBe(NODE_RED_EDITOR_PREFIX);
    expect(Object.keys(result.body).sort()).toEqual(["expiresAt", "url"]);
    const token = cookieOf(result).split("=")[1]!;
    expect(JSON.stringify(result.body)).not.toContain(token);
    expect(String(result.headers["set-cookie"])).toMatch(/HttpOnly/);
    expect(proxy.ready).toHaveBeenCalledOnce();
  });

  it.each([
    undefined,
    "https://evil.example",
    "null",
    "http://nova.example",
    "https://user@nova.example",
    "https://nova.example/path",
    "https://nova.example?query=1",
    "https://nova.example#fragment",
  ])(
    "rejects an invalid mint origin before probing upstream: %s",
    async (origin) => {
      const req = mint();
      if (origin === undefined) req.unset("Origin");
      else req.set("Origin", origin);
      const result = await req.send({});
      expect(result.status).toBe(403);
      expect(result.headers["set-cookie"]).toBeUndefined();
      expect(proxy.ready).not.toHaveBeenCalled();
    },
  );

  it("does not accept spoofed forwarding headers as the matching request host", async () => {
    const result = await mint()
      .set("Host", "evil.example")
      .set("X-Forwarded-Host", "nova.example")
      .send({});
    expect(result.status).toBe(403);
    expect(proxy.ready).not.toHaveBeenCalled();
  });

  it.each([
    ["array"],
    "text",
    { token: "not-accepted" },
    { url: "https://evil.example" },
  ])("rejects nonempty or malformed mint bodies", async (body) => {
    const result = await mint().send(body);
    expect(result.status).toBe(400);
    expect(proxy.ready).not.toHaveBeenCalled();
  });

  it("projects fixed readiness errors without upstream diagnostics or cookies", async () => {
    proxy.ready.mockRejectedValue(
      new Error("private-node-red-host?token=fixture-secret"),
    );
    const result = await mint().send({});
    expect(result.status).toBe(503);
    expect(result.body.error).toBe(
      "Node-RED-editor is tijdelijk niet beschikbaar.",
    );
    expect(JSON.stringify(result.body)).not.toContain("fixture-secret");
    expect(result.headers["set-cookie"]).toBeUndefined();
  });

  it("permits upstream without admin auth and refreshes existing sessions without a PIN", async () => {
    proxy.ready.mockResolvedValue(false);
    const initial = await mint().send({});
    const cookie = cookieOf(initial);
    const active = editor.authorize({
      headers: { host: "nova.example", cookie },
      method: "GET",
    } as never)!;
    expect(active.upstreamAuth).toBe(false);
    const result = await request(app.getHttpServer())
      .post(`${BASE}/renew`)
      .set("Host", "nova.example")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie)
      .send({});
    expect(result.status).toBe(200);
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(cookieOf(result)).toBe(cookie);
    expect(proxy.ready).toHaveBeenCalledOnce();
  });

  it("never creates a renewal session without an existing same-origin capability", async () => {
    const initial = await mint().send({});
    for (const [cookie, origin] of [
      ["", ORIGIN],
      [cookieOf(initial), "https://evil.example"],
      [cookieOf(initial), ""],
    ] as const) {
      const result = await request(app.getHttpServer())
        .post(`${BASE}/renew`)
        .set("Host", "nova.example")
        .set("Origin", origin)
        .set("Cookie", cookie)
        .send({});
      expect(result.status).toBe(403);
      expect(result.headers["set-cookie"]).toBeUndefined();
    }
    expect(proxy.ready).toHaveBeenCalledOnce();
  });

  it("closes only the authorized session and immediately revokes its tracked sockets", async () => {
    const first = await mint().send({});
    const second = await mint().send({});
    const cookie = cookieOf(first);
    const key = editor.authorize({
      headers: { host: "nova.example", cookie },
      method: "GET",
    } as never)!.key;
    const result = await request(app.getHttpServer())
      .delete(`${BASE}/session`)
      .set("Host", "nova.example")
      .set("Origin", ORIGIN)
      .set("Cookie", cookie);
    expect(result.status).toBe(200);
    expect(result.body).toEqual({ ok: true });
    expect(result.headers["cache-control"]).toBe("no-store");
    expect(proxy.closeSession).toHaveBeenCalledExactlyOnceWith(key);
    expect(
      editor.authorize({
        headers: { host: "nova.example", cookie },
        method: "GET",
      } as never),
    ).toBeNull();
    expect(
      editor.authorize({
        headers: { host: "nova.example", cookie: cookieOf(second) },
        method: "GET",
      } as never),
    ).not.toBeNull();
  });

  it("rejects cross-origin close without revoking the capability or any sockets", async () => {
    const initial = await mint().send({});
    const cookie = cookieOf(initial);
    const result = await request(app.getHttpServer())
      .delete(`${BASE}/session`)
      .set("Host", "nova.example")
      .set("Origin", "https://evil.example")
      .set("Cookie", cookie);
    expect(result.status).toBe(403);
    expect(proxy.closeSession).not.toHaveBeenCalled();
    expect(
      editor.authorize({
        headers: { host: "nova.example", cookie },
        method: "GET",
      } as never),
    ).not.toBeNull();
  });
});

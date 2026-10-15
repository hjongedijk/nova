import { afterEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server, type IncomingMessage } from "node:http";
import { once } from "node:events";
import WebSocket, { WebSocketServer } from "ws";
import type { Duplex } from "node:stream";
import type {
  NodeRedEditorAccess,
  Session,
} from "../../src/settings/node-red-editor-access.service.js";
import { NodeRedEditorWebSocket } from "../../src/settings/node-red-editor-websocket.js";

const TOKEN = "private-fixture-token";
const PATH = "/api/node-red-editor/comms";
const cleanups: (() => Promise<void> | void)[] = [];

async function listen(server: Server): Promise<number> {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return (server.address() as { port: number }).port;
}

async function fixture(upstreamAuth = true) {
  const session: Session = {
    key: "fixture-session",
    origin: "https://nova.example",
    expiresAt: Date.now() + 60_000,
    upstreamAuth,
  };
  let authorized = true;
  const authorize = vi.fn((request: IncomingMessage, requireOrigin: boolean) =>
    authorized &&
    requireOrigin &&
    request.headers.origin === session.origin &&
    request.headers.cookie === "editor=fixture"
      ? { ...session }
      : null,
  );
  const upstreamHttp = createServer();
  const upstreamServer = new WebSocketServer({ noServer: true });
  upstreamHttp.on("upgrade", (request, socket, head) => {
    upstreamServer.handleUpgrade(request, socket, head, (ws) => {
      upstreamServer.emit("connection", ws, request);
    });
  });
  const upstreamPort = await listen(upstreamHttp);
  const bridge = new NodeRedEditorWebSocket(
    { authorize } as unknown as NodeRedEditorAccess,
    () => new URL(`http://127.0.0.1:${upstreamPort}/admin/`),
    () => TOKEN,
  );
  const browserHttp = createServer();
  browserHttp.on("upgrade", (request, socket, head) => {
    if (!bridge.upgrade(request, socket, head)) socket.destroy();
  });
  const port = await listen(browserHttp);
  cleanups.push(async () => {
    bridge.close();
    for (const ws of upstreamServer.clients) ws.terminate();
    await Promise.all([
      new Promise<void>((resolve) => browserHttp.close(() => resolve())),
      new Promise<void>((resolve) => upstreamHttp.close(() => resolve())),
      new Promise<void>((resolve) => upstreamServer.close(() => resolve())),
    ]);
  });
  const browser = (origin = session.origin, path = PATH) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}${path}`, {
      origin,
      headers: {
        cookie: "editor=fixture",
        authorization: "Bearer browser-supplied",
      },
    });
    // A negative test may close before awaiting an error event.
    ws.on("error", () => undefined);
    return ws;
  };
  return {
    bridge,
    upstreamServer,
    browser,
    session,
    authorize,
    revoke: () => {
      authorized = false;
    },
  };
}

afterEach(async () => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

describe("Node-RED editor WebSocket bridge", () => {
  it("authenticates privately before releasing queued subscriptions and consumes acknowledgments", async () => {
    const f = await fixture();
    const connection = once(f.upstreamServer, "connection");
    const browser = f.browser();
    const seen: string[] = [];
    browser.on("message", (data) => seen.push(data.toString()));
    await once(browser, "open");
    browser.send(JSON.stringify({ subscribe: "debug" }));
    const [upstream, request] = (await connection) as [
      WebSocket,
      IncomingMessage,
    ];
    const frames: string[] = [];
    const first = await new Promise<string>((resolve) => {
      upstream.on("message", (data) => {
        frames.push(data.toString());
        resolve(data.toString());
      });
    });
    expect(request.url).toBe("/admin/comms");
    expect(request.headers.authorization).toBe(`Bearer ${TOKEN}`);
    expect(request.headers.cookie).toBeUndefined();
    expect(request.headers.origin).toBeUndefined();
    expect(JSON.parse(first)).toEqual({ auth: TOKEN });
    expect(frames).toHaveLength(1);
    const subscription = once(upstream, "message");
    upstream.send(JSON.stringify({ auth: "ok" }));
    expect(JSON.parse((await subscription)[0].toString())).toEqual({
      subscribe: "debug",
    });
    const received = once(browser, "message");
    upstream.send(JSON.stringify([{ topic: "debug", data: "fixture" }]));
    expect(JSON.parse((await received)[0].toString())).toEqual([
      { topic: "debug", data: "fixture" },
    ]);
    expect(seen.join(" ")).not.toContain(TOKEN);
    expect(seen.join(" ")).not.toContain('"auth"');
    expect(f.authorize).toHaveBeenCalledWith(expect.anything(), true);
  });

  it("relays an auth-disabled editor without sending an auth frame", async () => {
    const f = await fixture(false);
    const connection = once(f.upstreamServer, "connection");
    const browser = f.browser();
    await once(browser, "open");
    const [upstream] = (await connection) as [WebSocket];
    const received = once(upstream, "message");
    browser.send(JSON.stringify({ subscribe: "status/#" }));
    expect(JSON.parse((await received)[0].toString())).toEqual({
      subscribe: "status/#",
    });
  });

  it("rejects cross-origin upgrades without contacting upstream", async () => {
    const f = await fixture();
    const upstream = vi.fn();
    f.upstreamServer.on("connection", upstream);
    const browser = f.browser("https://evil.example");
    const [error] = await once(browser, "error");
    expect(error.message).toContain("403");
    expect(upstream).not.toHaveBeenCalled();
  });

  it("scopes the listener to the exact path and rejects query variants", async () => {
    const f = await fixture();
    const socket = { end: vi.fn(), destroy: vi.fn() };
    expect(
      f.bridge.upgrade(
        { url: "/other/comms" } as IncomingMessage,
        socket as unknown as Duplex,
        Buffer.alloc(0),
      ),
    ).toBe(false);
    expect(socket.end).not.toHaveBeenCalled();
    const browser = f.browser(undefined, `${PATH}?token=browser`);
    const [error] = await once(browser, "error");
    expect(error.message).toContain("403");
  });

  it.each([JSON.stringify({ auth: "browser-token" }), "not-json"])(
    "rejects browser authentication and malformed packets: %s",
    async (packet) => {
      const f = await fixture(false);
      const connection = once(f.upstreamServer, "connection");
      const browser = f.browser();
      await once(browser, "open");
      const [upstream] = (await connection) as [WebSocket];
      const received = vi.fn();
      upstream.on("message", received);
      const closed = once(browser, "close");
      browser.send(packet);
      await closed;
      expect(received).not.toHaveBeenCalled();
    },
  );

  it("fails closed on upstream auth rejection without exposing its message", async () => {
    const f = await fixture();
    const connection = once(f.upstreamServer, "connection");
    const browser = f.browser();
    const received = vi.fn();
    browser.on("message", received);
    await once(browser, "open");
    const [upstream] = (await connection) as [WebSocket];
    await once(upstream, "message");
    const closed = once(browser, "close");
    upstream.send(JSON.stringify({ auth: "fail", private: TOKEN }));
    await closed;
    expect(received).not.toHaveBeenCalled();
  });

  it("bounds pending subscription queues while waiting for upstream authentication", async () => {
    const f = await fixture();
    const browser = f.browser();
    await once(browser, "open");
    const closed = once(browser, "close");
    for (let index = 0; index < 129; index++)
      browser.send(JSON.stringify({ subscribe: `topic/${index}` }));
    await closed;
  });

  it("closes revoked sessions before forwarding further traffic", async () => {
    const f = await fixture(false);
    const connection = once(f.upstreamServer, "connection");
    const browser = f.browser();
    await once(browser, "open");
    const [upstream] = (await connection) as [WebSocket];
    const received = vi.fn();
    upstream.on("message", received);
    f.revoke();
    const closed = once(browser, "close");
    browser.send(JSON.stringify({ subscribe: "private" }));
    await closed;
    expect(received).not.toHaveBeenCalled();
  });

  it("closes both peers for an explicit session revocation", async () => {
    const f = await fixture(false);
    const connection = once(f.upstreamServer, "connection");
    const browser = f.browser();
    await once(browser, "open");
    const [upstream] = (await connection) as [WebSocket];
    const closed = Promise.all([
      once(browser, "close"),
      once(upstream, "close"),
    ]);
    f.bridge.closeSession("unrelated");
    expect(browser.readyState).toBe(WebSocket.OPEN);
    f.bridge.closeSession(f.session.key);
    await closed;
  });

  it("reauthorizes idle connections on the heartbeat", async () => {
    const f = await fixture(false);
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const connection = once(f.upstreamServer, "connection");
    const browser = f.browser();
    await once(browser, "open");
    await connection;
    const closed = once(browser, "close");
    f.revoke();
    await vi.advanceTimersByTimeAsync(15_000);
    await closed;
  });

  it("expires upstream authentication attempts without relaying queued traffic", async () => {
    const f = await fixture();
    vi.useFakeTimers({
      toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"],
    });
    const connection = once(f.upstreamServer, "connection");
    const browser = f.browser();
    await once(browser, "open");
    const [upstream] = (await connection) as [WebSocket];
    await once(upstream, "message");
    const received = vi.fn();
    upstream.on("message", received);
    browser.send(JSON.stringify({ subscribe: "debug" }));
    const closed = once(browser, "close");
    await vi.advanceTimersByTimeAsync(10_000);
    await closed;
    expect(received).not.toHaveBeenCalled();
  });
});

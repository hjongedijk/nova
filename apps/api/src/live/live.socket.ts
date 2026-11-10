import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import type {
  LiveClientMessage,
  LiveFrameHeader,
  LiveStatusMessage,
} from "@nova/contracts";
import WebSocket, { WebSocketServer } from "ws";
import {
  hostAllowed,
  originAllowed,
  type RequestGuardOptions,
} from "../core/security/request-origin.js";
import {
  BandwidthBudget,
  clampFps,
  clampWidth,
  encodeFrame,
  FrameGate,
  LIVE_LIMITS,
} from "./frame-gate.js";
import type { LiveStreamsService } from "./live-streams.service.js";

export const LIVE_PATH = "/api/live";
const HEARTBEAT_MS = 20_000;
const KEY = /^[A-Za-z0-9_-]{1,64}$/;

/**
 * /api/live: the websocket that carries live video to NOVA's windows. A websocket is not covered by CORS, so the
 * upgrade itself is the guard: a browser Origin is required and must be NOVA's own (or an allowed host), and the
 * Host must not be a rebound public name. Same rules as the /api request guard, stricter on Origin.
 */
export function liveUpgradeAllowed(
  request: Pick<IncomingMessage, "headers" | "method" | "url">,
  options: RequestGuardOptions,
): boolean {
  const header = (name: string) => {
    const value = request.headers[name];
    return Array.isArray(value) ? value[0] : value;
  };
  const origin = header("origin");
  return (
    request.method === "GET" &&
    request.url === LIVE_PATH &&
    hostAllowed(header("host"), options) &&
    typeof origin === "string" &&
    originAllowed(origin, header("host"), options)
  );
}

export function parseClientMessage(raw: string): LiveClientMessage | null {
  if (raw.length > 2048) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!value || typeof value !== "object") return null;
  const message = value as Record<string, unknown>;
  if (typeof message.key !== "string" || !KEY.test(message.key)) return null;
  if (message.type === "unsubscribe")
    return { type: "unsubscribe", key: message.key };
  if (message.type === "budget")
    return {
      type: "budget",
      key: message.key,
      fps: clampFps(message.fps),
      maxWidth: clampWidth(message.maxWidth),
    };
  if (
    message.type === "subscribe" &&
    (message.stream === "browser" || message.stream === "desktop")
  ) {
    const display =
      Number.isSafeInteger(message.display) &&
      (message.display as number) >= 0 &&
      (message.display as number) <= 32
        ? (message.display as number)
        : undefined;
    const tab =
      typeof message.tab === "string" &&
      /^[A-Za-z0-9-]{1,64}$/.test(message.tab)
        ? message.tab
        : undefined;
    return {
      type: "subscribe",
      key: message.key,
      stream: message.stream,
      ...(display !== undefined ? { display } : {}),
      ...(tab ? { tab } : {}),
      fps: clampFps(message.fps),
      maxWidth: clampWidth(message.maxWidth),
    };
  }
  return null;
}

export class LiveSocket {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: 4096,
    perMessageDeflate: false,
  });
  private readonly sockets = new Set<WebSocket>();
  /** Shared by every viewer: many windows together stay under one cap. */
  readonly bandwidth = new BandwidthBudget(LIVE_LIMITS.globalBytesPerSecond);

  constructor(
    private readonly streams: LiveStreamsService,
    private readonly guard: RequestGuardOptions,
  ) {}

  /** True when the request was for /api/live (answered or refused here). */
  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (request.url?.split("?")[0] !== LIVE_PATH) return false;
    if (
      !liveUpgradeAllowed(request, this.guard) ||
      this.sockets.size >= LIVE_LIMITS.maxSockets
    ) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return true;
    }
    this.server.handleUpgrade(request, socket, head, (ws) => this.accept(ws));
    return true;
  }

  close(): void {
    for (const ws of this.sockets) ws.terminate();
    this.server.close();
  }

  private accept(ws: WebSocket): void {
    this.sockets.add(ws);
    const subscriptions = new Map<
      string,
      { gate: FrameGate; stop: () => void; maxWidth: number }
    >();
    let alive = true;
    const heartbeat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, HEARTBEAT_MS);
    heartbeat.unref?.();
    ws.on("pong", () => (alive = true));
    const send = (status: LiveStatusMessage) => {
      if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(status));
    };
    const stopAll = () => {
      clearInterval(heartbeat);
      for (const entry of subscriptions.values()) entry.stop();
      subscriptions.clear();
      this.sockets.delete(ws);
    };
    ws.on("close", stopAll);
    ws.on("error", stopAll);
    ws.on("message", (data, binary) => {
      if (binary) return;
      const message = parseClientMessage(String(data));
      if (!message) return;
      const existing = subscriptions.get(message.key);
      if (message.type === "unsubscribe") {
        existing?.stop();
        subscriptions.delete(message.key);
        return;
      }
      if (message.type === "budget") {
        existing?.gate.setFps(message.fps);
        if (existing) existing.maxWidth = message.maxWidth;
        return;
      }
      if (existing) {
        existing.gate.setFps(message.fps);
        return;
      }
      if (subscriptions.size >= LIVE_LIMITS.maxSubscriptions) {
        send({
          type: "status",
          key: message.key,
          state: "offline",
          reason: "Te veel live vensters tegelijk.",
        });
        return;
      }
      const gate = new FrameGate(message.fps);
      const key = message.key;
      const stop = this.streams.subscribe(
        {
          stream: message.stream,
          display: message.display,
          tab: message.tab,
          fps: message.fps,
          maxWidth: message.maxWidth,
        },
        {
          status: (state, reason) =>
            send({ type: "status", key, state, ...(reason ? { reason } : {}) }),
          frame: (frame) => {
            if (ws.readyState !== WebSocket.OPEN) return;
            if (
              gate.offer(
                frame.jpeg.length,
                ws.bufferedAmount,
                Date.now(),
                this.bandwidth,
              ) !== "send"
            )
              return;
            const header: LiveFrameHeader = {
              key,
              seq: frame.seq,
              width: frame.width,
              height: frame.height,
              mime: "image/jpeg",
              ...(frame.url ? { url: frame.url } : {}),
              ...(frame.title ? { title: frame.title } : {}),
              ...(frame.tab ? { tab: frame.tab } : {}),
              ...(frame.vw ? { vw: frame.vw } : {}),
              ...(frame.vh ? { vh: frame.vh } : {}),
            };
            ws.send(encodeFrame(header, frame.jpeg), { binary: true });
          },
        },
      );
      subscriptions.set(key, { gate, stop, maxWidth: message.maxWidth });
    });
  }
}

import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import {
  NODE_RED_EDITOR_PREFIX,
  type NodeRedEditorAccess,
} from "./node-red-editor-access.service.js";

const PATH = `${NODE_RED_EDITOR_PREFIX}comms`;
const MAX_BYTES = 1024 * 1024;
const MAX_QUEUE = 128;
const MAX_CONNECTIONS = 64;
const HEARTBEAT_MS = 15_000;
const CONNECT_MS = 10_000;

type Connection = { key: string; stop: () => void };

/** A browser capability is exchanged for upstream authentication only here. */
export class NodeRedEditorWebSocket {
  private readonly server = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_BYTES,
    perMessageDeflate: false,
  });
  private readonly connections = new Set<Connection>();
  private closed = false;

  constructor(
    private readonly access: NodeRedEditorAccess,
    private readonly baseUrl: () => URL,
    private readonly privateToken: () => string,
  ) {}

  upgrade(request: IncomingMessage, socket: Duplex, head: Buffer): boolean {
    if (request.url?.split("?")[0] !== PATH) return false;
    const session = this.access.authorize(request, true);
    if (
      this.closed ||
      request.url !== PATH ||
      request.method !== "GET" ||
      !session ||
      this.connections.size >= MAX_CONNECTIONS
    ) {
      socket.end(
        "HTTP/1.1 403 Forbidden\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return true;
    }

    let url: URL;
    let token: string;
    try {
      url = new URL(this.baseUrl().href);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
      )
        throw new Error("Invalid upstream");
      url.pathname = `${url.pathname.replace(/\/$/, "")}/comms`;
      url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
      token = this.privateToken();
      if (session.upstreamAuth && !token)
        throw new Error("Missing authentication");
    } catch {
      socket.end(
        "HTTP/1.1 503 Service Unavailable\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
      );
      return true;
    }

    try {
      this.server.handleUpgrade(request, socket, head, (browser) => {
        let upstream: WebSocket | undefined;
        let stopped = false;
        let ready = false;
        let browserAlive = true;
        let upstreamAlive = true;
        let queueBytes = 0;
        const queue: string[] = [];
        const timers: {
          expiry?: ReturnType<typeof setTimeout>;
          deadline?: ReturnType<typeof setTimeout>;
          heartbeat?: ReturnType<typeof setInterval>;
        } = {};
        const connection: Connection = {
          key: session.key,
          stop: () => {
            if (stopped) return;
            stopped = true;
            clearTimeout(timers.expiry);
            clearTimeout(timers.deadline);
            clearInterval(timers.heartbeat);
            queue.length = 0;
            queueBytes = 0;
            this.connections.delete(connection);
            browser.terminate();
            upstream?.terminate();
          },
        };
        const stop = connection.stop;
        this.connections.add(connection);

        const authorized = () => {
          const current = this.access.authorize(request, true);
          if (
            !current ||
            current.key !== session.key ||
            current.upstreamAuth !== session.upstreamAuth
          ) {
            stop();
            return null;
          }
          return current;
        };
        const checkExpiry = () => {
          const current = authorized();
          if (!current) return;
          timers.expiry = setTimeout(
            checkExpiry,
            Math.max(1, current.expiresAt - Date.now()),
          );
          timers.expiry.unref();
        };
        const send = (destination: WebSocket, text: string) => {
          const bytes = Buffer.byteLength(text);
          if (
            destination.readyState !== WebSocket.OPEN ||
            bytes > MAX_BYTES ||
            destination.bufferedAmount + bytes > MAX_BYTES
          ) {
            stop();
            return false;
          }
          destination.send(text, (error) => {
            if (error) stop();
          });
          return true;
        };
        const activate = () => {
          if (ready || stopped || !upstream || !authorized()) return;
          ready = true;
          clearTimeout(timers.deadline);
          for (const text of queue) if (!send(upstream, text)) break;
          queue.length = 0;
          queueBytes = 0;
        };

        browser.on("error", stop);
        browser.on("close", stop);
        browser.on("pong", () => {
          browserAlive = true;
        });
        browser.on("message", (data: RawData, binary: boolean) => {
          if (stopped || !authorized()) return;
          let text: string;
          try {
            if (binary) throw new Error("Invalid frame");
            text = data.toString();
            const packet: unknown = JSON.parse(text);
            if (
              !packet ||
              typeof packet !== "object" ||
              Array.isArray(packet) ||
              Object.hasOwn(packet, "auth")
            ) {
              throw new Error("Invalid frame");
            }
          } catch {
            stop();
            return;
          }
          if (ready && upstream) send(upstream, text);
          else {
            const bytes = Buffer.byteLength(text);
            if (queue.length >= MAX_QUEUE || queueBytes + bytes > MAX_BYTES) {
              stop();
              return;
            }
            queue.push(text);
            queueBytes += bytes;
          }
        });

        timers.deadline = setTimeout(stop, CONNECT_MS);
        timers.deadline.unref();
        checkExpiry();
        if (stopped) return;
        try {
          upstream = new WebSocket(url, {
            headers: token ? { authorization: `Bearer ${token}` } : {},
            handshakeTimeout: CONNECT_MS,
            maxPayload: MAX_BYTES,
            perMessageDeflate: false,
            followRedirects: false,
          });
        } catch {
          stop();
          return;
        }
        upstream.on("error", stop);
        upstream.on("close", stop);
        upstream.on("unexpected-response", (_request, response) => {
          response.destroy();
          stop();
        });
        upstream.on("pong", () => {
          upstreamAlive = true;
        });
        upstream.on("open", () => {
          if (stopped || !upstream || !authorized()) return;
          if (session.upstreamAuth)
            send(upstream, JSON.stringify({ auth: token }));
          else activate();
        });
        upstream.on("message", (data: RawData, binary: boolean) => {
          if (stopped || !authorized()) return;
          const text = data.toString();
          let packet: unknown;
          try {
            if (binary) throw new Error("Invalid frame");
            packet = JSON.parse(text);
          } catch {
            stop();
            return;
          }
          if (
            packet &&
            typeof packet === "object" &&
            !Array.isArray(packet) &&
            Object.hasOwn(packet, "auth")
          ) {
            if ((packet as { auth: unknown }).auth === "ok" && !ready)
              activate();
            else stop();
            return;
          }
          if (!ready || !Array.isArray(packet)) {
            stop();
            return;
          }
          send(browser, text);
        });
        timers.heartbeat = setInterval(() => {
          if (!authorized()) return;
          if (
            !browserAlive ||
            !upstreamAlive ||
            browser.bufferedAmount > MAX_BYTES ||
            (upstream?.bufferedAmount ?? 0) > MAX_BYTES
          ) {
            stop();
            return;
          }
          browserAlive = false;
          browser.ping(undefined, undefined, (error) => {
            if (error) stop();
          });
          if (upstream?.readyState === WebSocket.OPEN) {
            upstreamAlive = false;
            upstream.ping(undefined, undefined, (error) => {
              if (error) stop();
            });
          }
        }, HEARTBEAT_MS);
        timers.heartbeat.unref();
      });
    } catch {
      socket.destroy();
    }
    return true;
  }

  closeSession(key: string): void {
    for (const connection of this.connections)
      if (connection.key === key) connection.stop();
  }

  close(): void {
    this.closed = true;
    for (const connection of this.connections) connection.stop();
    this.server.close();
  }
}

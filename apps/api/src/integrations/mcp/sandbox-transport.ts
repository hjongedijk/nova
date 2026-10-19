import http from "node:http";
import https from "node:https";
import type { Duplex } from "node:stream";
import {
  JSONRPCMessageSchema,
  type JSONRPCMessage,
} from "@modelcontextprotocol/sdk/types.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";

const MAX_MESSAGE_BYTES = 1024 * 1024;
const CONNECT_TIMEOUT_MS = 90_000;
export type IsolatedMcpServer =
  | "sequential-thinking"
  | "filesystem"
  | "workspace-git"
  | "context7"
  | "imap"
  | "caldav";

/** MCP JSON lines over the authenticated broker's isolated-container stream. */
export class SandboxMcpTransport implements Transport {
  onclose?: Transport["onclose"];
  onerror?: Transport["onerror"];
  onmessage?: Transport["onmessage"];
  private socket?: Duplex;
  private request?: http.ClientRequest;
  private buffer = Buffer.alloc(0);
  private started = false;
  private closed = false;

  constructor(
    private readonly brokerUrl: string,
    private readonly token: string,
    private readonly server: IsolatedMcpServer,
    private readonly projectId?: string,
    private readonly credentials?: Record<string, string>,
  ) {}

  async start(): Promise<void> {
    if (this.started || this.closed)
      throw new Error("MCP transport already started or closed");
    this.started = true;
    const target = new URL(this.brokerUrl);
    if (
      !["http:", "https:"].includes(target.protocol) ||
      target.username ||
      target.password ||
      target.search ||
      target.hash ||
      target.pathname !== "/" ||
      !/^[a-f0-9]{64}$/i.test(this.token)
    )
      throw new Error("MCP isolation broker is not configured");
    target.pathname = "/mcp/offline";
    target.searchParams.set("server", this.server);
    if (this.projectId !== undefined)
      target.searchParams.set("projectId", this.projectId);
    await new Promise<void>((resolve, reject) => {
      const request = (target.protocol === "https:" ? https : http).request(
        target,
        {
          headers: {
            authorization: `Bearer ${this.token}`,
            ...(this.credentials
              ? {
                  "x-nova-mcp-credentials": Buffer.from(
                    JSON.stringify(this.credentials),
                  ).toString("base64url"),
                }
              : {}),
            connection: "Upgrade",
            upgrade: "nova-mcp",
          },
        },
      );
      this.request = request;
      request.setTimeout(CONNECT_TIMEOUT_MS, () =>
        request.destroy(new Error("MCP isolation connection timed out")),
      );
      request.once("response", (response) => {
        response.resume();
        request.destroy();
        reject(new Error("MCP isolation broker refused the connection"));
      });
      request.once("error", () =>
        reject(new Error("MCP isolation broker is unavailable")),
      );
      request.once("upgrade", (response, socket, head) => {
        request.setTimeout(0);
        if (
          this.closed ||
          response.statusCode !== 101 ||
          response.headers.upgrade?.toLowerCase() !== "nova-mcp"
        ) {
          socket.destroy();
          reject(new Error("MCP isolation broker refused the connection"));
          return;
        }
        this.request = undefined;
        this.socket = socket;
        socket.on("data", (chunk) => this.receive(Buffer.from(chunk)));
        socket.once("error", () => {
          this.onerror?.(new Error("MCP isolation stream failed"));
          void this.close();
        });
        socket.once("end", () => void this.close());
        socket.once("close", () => void this.close());
        if (head.length) this.receive(head);
        resolve();
      });
      request.end();
    });
  }

  private receive(chunk: Buffer): void {
    if (this.closed) return;
    this.buffer = Buffer.concat([this.buffer, chunk]);
    try {
      let end: number;
      while ((end = this.buffer.indexOf(10)) >= 0) {
        if (end > MAX_MESSAGE_BYTES) throw new Error("oversized message");
        const line = this.buffer.subarray(0, end).toString("utf8");
        this.buffer = this.buffer.subarray(end + 1);
        if (line.trim()) {
          const message = JSONRPCMessageSchema.parse(JSON.parse(line));
          this.onmessage?.(message);
        }
      }
      if (this.buffer.length > MAX_MESSAGE_BYTES)
        throw new Error("oversized message");
    } catch {
      this.onerror?.(new Error("MCP isolation stream returned invalid data"));
      void this.close();
    }
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const socket = this.socket;
    if (!socket || this.closed)
      throw new Error("MCP isolation stream is closed");
    const data = `${JSON.stringify(message)}\n`;
    if (Buffer.byteLength(data) > MAX_MESSAGE_BYTES)
      throw new Error("MCP message is too large");
    await new Promise<void>((resolve, reject) => {
      socket.write(data, (error) =>
        error
          ? reject(new Error("MCP isolation stream write failed"))
          : resolve(),
      );
    });
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    this.request?.destroy();
    this.request = undefined;
    this.socket?.destroy();
    this.socket = undefined;
    this.buffer = Buffer.alloc(0);
    this.onclose?.();
  }
}

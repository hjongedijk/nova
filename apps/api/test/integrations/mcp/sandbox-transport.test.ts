import http from "node:http";
import type { Duplex } from "node:stream";
import { once } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SandboxMcpTransport } from "../../../src/integrations/mcp/sandbox-transport.js";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup();
});

async function fixture(
  onUpgrade?: (request: http.IncomingMessage, socket: Duplex) => void,
) {
  const sockets = new Set<Duplex>();
  const server = http.createServer((_request, response) => {
    response.writeHead(503);
    response.end("private upstream diagnostics");
  });
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("error", () => undefined);
    socket.on("close", () => sockets.delete(socket));
  });
  if (onUpgrade)
    server.on("upgrade", (request, socket) => onUpgrade(request, socket));
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  const address = server.address();
  if (!address || typeof address === "string")
    throw new Error("test server unavailable");
  cleanups.push(async () => {
    for (const socket of sockets) socket.destroy();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
  return `http://127.0.0.1:${address.port}`;
}

const token = "a".repeat(64);
describe("isolated MCP broker transport", () => {
  it("authenticates a fixed offline server and exchanges fragmented JSON lines", async () => {
    let peer: Duplex;
    const received: string[] = [];
    const base = await fixture((request, socket) => {
      expect(request.headers.authorization).toBe(`Bearer ${token}`);
      expect(request.headers.upgrade).toBe("nova-mcp");
      expect(request.url).toBe(
        "/mcp/offline?server=workspace-git&projectId=project-a",
      );
      peer = socket;
      socket.on("data", (chunk) => received.push(chunk.toString()));
      socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: nova-mcp\r\n\r\n",
      );
    });
    const transport = new SandboxMcpTransport(
      base,
      token,
      "workspace-git",
      "project-a",
    );
    const onclose = vi.fn();
    transport.onclose = onclose;
    const message = new Promise<unknown>((resolve) => {
      transport.onmessage = resolve;
    });
    await transport.start();
    const text = Buffer.from(
      JSON.stringify({ jsonrpc: "2.0", id: 1, result: { text: "NOVA café" } }) +
        "\n",
    );
    peer!.write(text.subarray(0, text.length - 4));
    peer!.write(text.subarray(text.length - 4));
    expect(await message).toEqual({
      jsonrpc: "2.0",
      id: 1,
      result: { text: "NOVA café" },
    });
    await transport.send({ jsonrpc: "2.0", id: 2, method: "tools/list" });
    await vi.waitFor(() =>
      expect(received.join("")).toContain('"method":"tools/list"'),
    );
    await transport.close();
    await transport.close();
    expect(onclose).toHaveBeenCalledOnce();
  });

  it("returns a fixed failure for refused upgrades without exposing their body", async () => {
    const transport = new SandboxMcpTransport(
      await fixture(),
      token,
      "filesystem",
    );
    await expect(transport.start()).rejects.toThrow(
      "MCP isolation broker refused the connection",
    );
    await transport.close();
  });

  it.each([
    "http://user:secret@localhost",
    "http://localhost?secret=value",
    "file:///private",
    "http://localhost/path",
  ])("rejects an unsafe broker URL before connecting: %s", async (base) => {
    await expect(
      new SandboxMcpTransport(base, token, "filesystem").start(),
    ).rejects.toThrow("MCP isolation broker is not configured");
  });

  it("closes malformed or oversized streams with safe diagnostic text", async () => {
    for (const input of [
      '{"private-password":"secret"}\n',
      "x".repeat(1024 * 1024 + 1),
    ]) {
      let peer: Duplex;
      const base = await fixture((_request, socket) => {
        peer = socket;
        socket.write(
          "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: nova-mcp\r\n\r\n",
        );
      });
      const transport = new SandboxMcpTransport(
        base,
        token,
        "sequential-thinking",
      );
      const error = vi.fn();
      transport.onerror = error;
      const closed = new Promise<void>((resolve) => {
        transport.onclose = resolve;
      });
      await transport.start();
      peer!.write(input);
      await closed;
      expect(error).toHaveBeenCalledOnce();
      expect(error.mock.calls[0]?.[0].message).toBe(
        "MCP isolation stream returned invalid data",
      );
      await expect(
        transport.send({ jsonrpc: "2.0", method: "tools/list" }),
      ).rejects.toThrow("MCP isolation stream is closed");
    }
  });
});

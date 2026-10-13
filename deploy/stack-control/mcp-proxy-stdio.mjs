import http from "node:http";
import { spawn } from "node:child_process";

/** Loopback-to-Unix bridge inside a network-less Context7 worker. Never chooses an upstream host. */
export function createContext7WorkerProxy({
  socketPath = "/run/nova-mcp-relay/relay.sock",
} = {}) {
  const server = http.createServer(
    { maxHeaderSize: 16 * 1024, requestTimeout: 15_000 },
    (request, response) => {
      const fail = () => {
        if (response.headersSent) {
          response.destroy();
          return;
        }
        response.writeHead(502, {
          "content-type": "application/json",
          "cache-control": "no-store",
        });
        response.end(
          JSON.stringify({ error: "Documentation relay unavailable" }),
        );
      };
      if (
        request.method !== "GET" ||
        request.headers["transfer-encoding"] ||
        (request.headers["content-length"] &&
          request.headers["content-length"] !== "0") ||
        (request.url?.length ?? 0) > 16 * 1024
      ) {
        response.writeHead(400);
        response.end();
        return;
      }
      const upstream = http.request(
        { socketPath, method: "GET", path: request.url },
        (incoming) => {
          response.writeHead(incoming.statusCode ?? 502, {
            "content-type":
              incoming.headers["content-type"] ?? "application/octet-stream",
            "cache-control": "no-store",
          });
          let bytes = 0;
          incoming.on("data", (chunk) => {
            bytes += chunk.length;
            if (bytes > 1024 * 1024) {
              upstream.destroy();
              response.destroy();
              return;
            }
            if (!response.write(chunk)) incoming.pause();
          });
          response.on("drain", () => incoming.resume());
          incoming.on("end", () => response.end());
          incoming.on("error", fail);
        },
      );
      upstream.on("error", fail);
      upstream.setTimeout(15_000, () => upstream.destroy());
      response.on("close", () => upstream.destroy());
      upstream.end();
    },
  );
  server.on("upgrade", (_request, socket) => socket.destroy());
  server.on("connect", (_request, socket) => socket.destroy());
  server.on("clientError", (_error, socket) => socket.destroy());
  return server;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  if (process.argv[2] !== "context7" || process.argv.length !== 3) {
    console.error("Unsupported MCP relay worker");
    process.exit(1);
  }
  const server = createContext7WorkerProxy();
  server.listen(0, "127.0.0.1", () => {
    const port = server.address().port;
    const child = spawn("context7-mcp", [], {
      env: {
        ...process.env,
        CONTEXT7_API_URL: `http://127.0.0.1:${port}/api`,
        HTTPS_PROXY: "",
        HTTP_PROXY: "",
        ALL_PROXY: "",
        https_proxy: "",
        http_proxy: "",
        all_proxy: "",
      },
      stdio: "inherit",
    });
    let finishing = false;
    const finish = (code) => {
      if (finishing) return;
      finishing = true;
      child.kill();
      server.closeAllConnections();
      server.close(() => process.exit(Number.isInteger(code) ? code : 1));
    };
    child.once("exit", (code) => finish(code));
    child.once("error", () => {
      console.error("MCP relay worker unavailable");
      finish(1);
    });
    process.once("SIGTERM", () => finish(0));
    process.once("SIGINT", () => finish(0));
  });
}

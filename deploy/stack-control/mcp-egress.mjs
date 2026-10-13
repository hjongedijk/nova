import http from "node:http";
import https from "node:https";

const MAX_URL_BYTES = 16 * 1024;
const MAX_BODY_BYTES = 1024 * 1024;
const TIMEOUT_MS = 15_000;
const hasControlCharacters = (value) =>
  [...value].some((character) => {
    const code = character.charCodeAt(0);
    return code < 32 || code === 127;
  });
const ROUTES = new Map([
  ["/api/v2/libs/search", { query: 8192, libraryName: 1024 }],
  ["/api/v2/context", { query: 8192, libraryId: 1024, language: 64 }],
]);

function upstreamPath(req) {
  const target = req.url ?? "";
  if (
    req.method !== "GET" ||
    Buffer.byteLength(target) > MAX_URL_BYTES ||
    target.includes("#") ||
    req.headers.upgrade !== undefined ||
    req.headers["transfer-encoding"] !== undefined ||
    (req.headers["content-length"] !== undefined &&
      req.headers["content-length"] !== "0")
  )
    return null;
  if (target === "/health") return target;
  const separator = target.indexOf("?");
  if (separator < 0) return null;
  // Match the raw path: URL normalization must never admit path aliases.
  const path = target.slice(0, separator);
  const allowed = ROUTES.get(path);
  if (!allowed) return null;
  const query = target.slice(separator + 1);
  if (
    /%(?![0-9a-f]{2})/i.test(query) ||
    query
      .split("&")
      .some((pair) => !Object.hasOwn(allowed, pair.slice(0, pair.indexOf("="))))
  )
    return null;
  const params = new URLSearchParams(query);
  const clean = new URLSearchParams();
  for (const [key, value] of params) {
    if (
      !Object.hasOwn(allowed, key) ||
      clean.has(key) ||
      !value ||
      Buffer.byteLength(value) > allowed[key] ||
      hasControlCharacters(value)
    )
      return null;
    clean.set(key, value);
  }
  for (const key of Object.keys(allowed)) {
    if (key !== "language" && !clean.has(key)) return null;
  }
  return `${path}?${clean}`;
}

function reply(res, status, body) {
  if (res.destroyed || res.writableEnded) return;
  res.writeHead(status, {
    "Content-Type": "text/plain; charset=utf-8",
    "Content-Length": Buffer.byteLength(body),
    "Cache-Control": "no-store",
  });
  res.end(body);
}

/** Fixed-destination Context7 API relay. Successful bodies are untrusted docs. */
export function createContext7Relay({ request = https.request } = {}) {
  let activeRequests = 0;
  const server = http.createServer({ maxHeaderSize: 20 * 1024 }, (req, res) => {
    req.on("error", () => {});
    const path = upstreamPath(req);
    if (!path) {
      req.resume();
      reply(res, 400, "Invalid Context7 request.\n");
      return;
    }
    let incomingBytes = 0;
    req.on("data", (chunk) => {
      incomingBytes += chunk.length;
    });
    // Check the complete inbound message before creating any upstream request.
    req.on("end", () => {
      if (incomingBytes) {
        reply(res, 400, "Invalid Context7 request.\n");
        return;
      }
      if (res.destroyed) return;
      if (path === "/health") {
        res.writeHead(200, {
          "Content-Type": "application/json",
          "Content-Length": 11,
        });
        res.end('{"ok":true}');
        return;
      }
      if (activeRequests >= 4) {
        reply(res, 503, "Context7 relay busy.\n");
        return;
      }
      activeRequests += 1;
      let upstream;
      let response;
      let complete = false;
      const timer = setTimeout(() => fail(), TIMEOUT_MS);
      timer.unref?.();
      const finish = () => {
        if (complete) return;
        complete = true;
        activeRequests -= 1;
        clearTimeout(timer);
      };
      const fail = () => {
        if (complete) return;
        finish();
        response?.destroy();
        upstream?.destroy();
        reply(res, 502, "Context7 upstream unavailable.\n");
      };
      res.once("close", () => {
        if (!complete) {
          finish();
          response?.destroy();
          upstream?.destroy();
        }
      });
      try {
        upstream = request(
          {
            protocol: "https:",
            hostname: "context7.com",
            port: 443,
            servername: "context7.com",
            rejectUnauthorized: true,
            method: "GET",
            path,
            // No shared/custom agent, proxy, caller credentials or headers.
            agent: false,
            headers: {
              Host: "context7.com",
              Accept: "application/json, text/plain",
              "User-Agent": "nova-context7-relay",
            },
          },
          (source) => {
            response = source;
            source.on("error", fail);
            source.on("aborted", fail);
            if (complete) {
              source.destroy();
              return;
            }
            if (
              source.statusCode < 200 ||
              source.statusCode >= 300 ||
              !Number.isInteger(source.statusCode) ||
              source.headers["content-encoding"] !== undefined
            ) {
              fail();
              return;
            }
            const chunks = [];
            let size = 0;
            source.on("data", (chunk) => {
              if (complete) return;
              size += chunk.length;
              if (size > MAX_BODY_BYTES) {
                fail();
                return;
              }
              chunks.push(Buffer.from(chunk));
            });
            source.on("end", () => {
              if (complete) return;
              finish();
              const body = Buffer.concat(chunks, size);
              const type = source.headers["content-type"];
              const headers = {
                "Content-Type":
                  typeof type === "string" &&
                  type.length <= 256 &&
                  !hasControlCharacters(type)
                    ? type
                    : "application/octet-stream",
                "Content-Length": body.length,
                "Cache-Control": "no-store",
              };
              res.writeHead(source.statusCode, headers);
              res.end(body);
            });
            source.on("close", () => {
              if (!source.complete) fail();
            });
          },
        );
        upstream.on("error", fail);
        if (complete) upstream.destroy();
        else upstream.end();
      } catch {
        fail();
      }
    });
  });
  const rejectTunnel = (_req, socket) => {
    socket.end(
      "HTTP/1.1 400 Bad Request\r\nConnection: close\r\nContent-Length: 0\r\n\r\n",
    );
  };
  server.on("connect", rejectTunnel);
  server.on("upgrade", rejectTunnel);
  server.requestTimeout = TIMEOUT_MS;
  server.headersTimeout = TIMEOUT_MS;
  return server;
}

import http from "node:http";

const MAX_BYTES = 1024 * 1024;
const PREPARE_TIMEOUT_MS = 75_000;
const SESSION_TIMEOUT_MS = 30 * 60_000;
const SERVERS = new Set([
  "sequential-thinking",
  "filesystem",
  "workspace-git",
  "context7",
]);
const PROJECT_ID = /^[a-z0-9](?:[a-z0-9-]{0,46}[a-z0-9])?$/;

function reject(socket, status) {
  if (!socket.destroyed)
    socket.end(
      `HTTP/1.1 ${status}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
    );
}

function parseRequest(request, head) {
  const url = new URL(request.url ?? "/", "http://stack-control");
  const params = url.searchParams;
  if (
    request.method !== "GET" ||
    url.pathname !== "/mcp/offline" ||
    url.hash ||
    head.length ||
    request.headers.upgrade?.toLowerCase() !== "nova-mcp" ||
    !request.headers.connection
      ?.toLowerCase()
      .split(/\s*,\s*/)
      .includes("upgrade") ||
    request.headers["transfer-encoding"] !== undefined ||
    (request.headers["content-length"] !== undefined &&
      request.headers["content-length"] !== "0") ||
    [...params.keys()].some((key) => !["server", "projectId"].includes(key)) ||
    params.getAll("server").length !== 1 ||
    params.getAll("projectId").length > 1 ||
    !SERVERS.has(params.get("server"))
  )
    throw new Error("invalid request");
  const server = params.get("server");
  if (server === "workspace-git") {
    if (!PROJECT_ID.test(params.get("projectId") ?? ""))
      throw new Error("invalid request");
    return { server, projectId: params.get("projectId") };
  }
  if (params.has("projectId")) throw new Error("invalid request");
  return { server };
}

// Scan bytes instead of buffering whole messages, keeping memory bounded even
// when a peer sends an incomplete line. Limits apply independently of chunks.
function lineLimit() {
  let size = 0;
  return (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      const newline = chunk.indexOf(10, offset);
      const end = newline === -1 ? chunk.length : newline;
      size += end - offset;
      if (size > MAX_BYTES) throw new Error("message too large");
      if (newline === -1) break;
      size = 0;
      offset = newline + 1;
    }
  };
}

function stdoutDecoder(write) {
  const header = Buffer.alloc(8);
  const checkLine = lineLimit();
  let headerBytes = 0;
  let remaining = 0;
  let stdout = false;
  return (chunk) => {
    let offset = 0;
    while (offset < chunk.length) {
      if (!remaining) {
        const count = Math.min(8 - headerBytes, chunk.length - offset);
        chunk.copy(header, headerBytes, offset, offset + count);
        headerBytes += count;
        offset += count;
        if (headerBytes !== 8) continue;
        headerBytes = 0;
        if (![1, 2].includes(header[0]) || header[1] || header[2] || header[3])
          throw new Error("invalid frame");
        remaining = header.readUInt32BE(4);
        if (remaining > MAX_BYTES) throw new Error("frame too large");
        stdout = header[0] === 1;
        if (!remaining) continue;
      }
      const end = offset + Math.min(remaining, chunk.length - offset);
      if (stdout) {
        const data = chunk.subarray(offset, end);
        checkLine(data);
        write(data);
      }
      remaining -= end - offset;
      offset = end;
    }
  };
}

/** An authenticated raw newline MCP transport; Docker remains the only executor. */
export function createMcpUpgradeHandler({
  sandbox,
  docker,
  attach = dockerAttach,
  authorized,
}) {
  const sessions = new Set();
  let shuttingDown = false;
  const handler = async (request, socket, head = Buffer.alloc(0)) => {
    socket.pause();
    let stopped = false;
    let upgraded = false;
    let containerId;
    let dockerSocket;
    let prepareTimer;
    let sessionTimer;
    let cleanupPromise;
    let cleanupSucceeded = false;
    let initialized = false;
    let resolveInitialization;
    const initialization = new Promise((resolve) => {
      resolveInitialization = resolve;
    });
    const retire = () => {
      if (stopped && initialized && (!containerId || cleanupSucceeded))
        sessions.delete(session);
    };
    const cleanup = () => {
      if (containerId && !cleanupPromise) {
        cleanupPromise = (async () => {
          for (let attempt = 0; attempt < 3; attempt++) {
            try {
              await sandbox.close(containerId);
              cleanupSucceeded = true;
              retire();
              return;
            } catch {
              if (attempt < 2)
                await new Promise((resolve) => setTimeout(resolve, 1000));
            }
          }
          // The sandbox keeps this ID and its capacity reservation on failure.
          throw new Error("MCP sandbox cleanup failed");
        })();
        // Disconnect event handlers cannot await cleanup; shutdown reports its
        // fixed failure while the failed session remains tracked for inspection.
        cleanupPromise.catch(() => {});
      }
    };
    const stop = (status) => {
      if (stopped) return;
      stopped = true;
      clearTimeout(prepareTimer);
      clearTimeout(sessionTimer);
      dockerSocket?.destroy();
      if (status && !upgraded) reject(socket, status);
      else socket.destroy();
      cleanup();
    };
    const session = {
      stop,
      async awaitCleanup() {
        await initialization;
        await cleanupPromise;
      },
    };
    sessions.add(session);
    socket.on("error", () => stop());
    socket.on("end", () => stop());
    socket.on("close", () => stop());
    const checkLine = lineLimit();
    socket.on("data", (chunk) => {
      if (stopped) return;
      if (!upgraded) {
        stop("400 Bad Request");
        return;
      }
      try {
        checkLine(chunk);
        if (!dockerSocket.write(chunk)) socket.pause();
      } catch {
        stop();
      }
    });
    // Keep reading during preparation so a peer's FIN cancels the session.
    // Bytes sent before the successful upgrade are never forwarded to Docker.
    socket.resume();
    prepareTimer = setTimeout(
      () => stop("503 Service Unavailable"),
      PREPARE_TIMEOUT_MS,
    );
    prepareTimer.unref();
    try {
      if (shuttingDown) {
        stop("503 Service Unavailable");
        return;
      }
      if (!(await authorized(request))) {
        stop("401 Unauthorized");
        return;
      }
      if (stopped) return;
      let input;
      try {
        input = parseRequest(request, head);
      } catch {
        stop("400 Bad Request");
        return;
      }
      const prepared = await sandbox.prepare(input);
      containerId = prepared?.containerId;
      if (!containerId || typeof containerId !== "string")
        throw new Error("unavailable");
      if (stopped) {
        cleanup();
        return;
      }
      dockerSocket = await attach(containerId);
      if (stopped) {
        dockerSocket.destroy();
        cleanup();
        return;
      }
      if (dockerSocket.destroyed) throw new Error("unavailable");
      dockerSocket.pause();
      dockerSocket.on("error", () => stop());
      dockerSocket.on("end", () => stop());
      dockerSocket.on("close", () => stop());
      const decode = stdoutDecoder((chunk) => {
        if (!socket.write(chunk)) dockerSocket.pause();
      });
      dockerSocket.on("data", (chunk) => {
        if (stopped) return;
        try {
          decode(chunk);
        } catch {
          stop();
        }
      });
      socket.on("drain", () => {
        if (!stopped) dockerSocket.resume();
      });
      dockerSocket.on("drain", () => {
        if (!stopped) socket.resume();
      });
      await docker(
        `/containers/${encodeURIComponent(containerId)}/start`,
        "POST",
      );
      if (stopped) return;
      clearTimeout(prepareTimer);
      sessionTimer = setTimeout(() => stop(), SESSION_TIMEOUT_MS);
      sessionTimer.unref();
      upgraded = true;
      const ready = socket.write(
        "HTTP/1.1 101 Switching Protocols\r\nConnection: Upgrade\r\nUpgrade: nova-mcp\r\n\r\n",
      );
      socket.resume();
      if (ready) dockerSocket.resume();
    } catch {
      stop("503 Service Unavailable");
    } finally {
      initialized = true;
      resolveInitialization();
      retire();
    }
  };
  handler.shutdown = handler.closeAll = async () => {
    shuttingDown = true;
    const active = [...sessions];
    for (const session of active) session.stop();
    const results = await Promise.allSettled(
      active.map((session) => session.awaitCleanup()),
    );
    if (results.some((result) => result.status === "rejected"))
      throw new Error("MCP sandbox cleanup failed");
  };
  return handler;
}

/** Attach before starting so the MCP server's first stdout bytes cannot be lost. */
export function dockerAttach(containerId) {
  return new Promise((resolve, rejectAttach) => {
    let settled = false;
    const request = http.request({
      socketPath: "/var/run/docker.sock",
      path: `/containers/${encodeURIComponent(containerId)}/attach?stream=1&stdin=1&stdout=1&stderr=1`,
      method: "POST",
      headers: { Connection: "Upgrade", Upgrade: "tcp" },
    });
    const timeout = setTimeout(() => fail(), PREPARE_TIMEOUT_MS);
    timeout.unref();
    function fail() {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      request.destroy();
      rejectAttach(new Error("MCP attachment unavailable"));
    }
    request.on("error", fail);
    request.on("response", (response) => {
      response.destroy();
      fail();
    });
    request.on("upgrade", (response, socket, head) => {
      if (
        settled ||
        response.statusCode !== 101 ||
        response.headers.upgrade?.toLowerCase() !== "tcp"
      ) {
        socket.destroy();
        fail();
        return;
      }
      settled = true;
      clearTimeout(timeout);
      socket.pause();
      if (head.length) socket.unshift(head);
      resolve(socket);
    });
    request.end();
  });
}

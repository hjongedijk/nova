import crypto from "node:crypto";
import http from "node:http";
import { URL } from "node:url";
import { createCodeSandbox } from "./code-sandbox.mjs";
import { createMcpSandbox } from "./mcp-sandbox.mjs";
import { createMcpUpgradeHandler } from "./mcp-stream.mjs";
import { readNodeRedLogs } from "./node-red-logs.mjs";

export const STACK_SERVICES = Object.freeze({
  nova: "nova",
  "node-red": "nova-node-red",
  omniroute: "nova-omniroute",
  mqtt: "nova-mqtt",
  qdrant: "nova-qdrant",
  piper: "nova-piper",
  "home-assistant": "nova-home-assistant",
  "mcp-egress": "nova-mcp-egress",
});
export const STATUS_SERVICES = Object.freeze({
  ...STACK_SERVICES,
  "stack-control": "nova-stack-control",
});

export function dockerRequest(path, method = "GET", body, options = {}) {
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: "/var/run/docker.sock",
        path,
        method,
        ...(body !== undefined
          ? { headers: { "content-type": "application/json" } }
          : {}),
        timeout: options.timeoutMs ?? 5000,
      },
      (response) => {
        const chunks = [];
        let size = 0;
        response.on("data", (chunk) => {
          size += chunk.length;
          if (size > (options.maxBytes ?? 1024 * 1024)) {
            request.destroy(new Error("Docker response too large"));
            return;
          }
          chunks.push(chunk);
        });
        response.on("end", () => {
          const text = Buffer.concat(chunks).toString("utf8");
          if (response.statusCode < 200 || response.statusCode >= 300) {
            reject(new Error(`Docker API status ${response.statusCode}`));
            return;
          }
          if (options.raw) resolve(Buffer.concat(chunks));
          else {
            try {
              resolve(text ? JSON.parse(text) : null);
            } catch {
              reject(new Error("Invalid Docker response"));
            }
          }
        });
      },
    );
    request.on("timeout", () => request.destroy(new Error("Docker timeout")));
    request.on("error", reject);
    request.end(body === undefined ? undefined : JSON.stringify(body));
  });
}

const digest = (value) =>
  crypto.createHash("sha256").update(JSON.stringify(value)).digest("hex");
const safeEqual = (left, right) => {
  const a = Buffer.from(left);
  const b = Buffer.from(right);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};

const MCP_WORKERS = [
  "sequential-thinking",
  "filesystem",
  "context7",
  "workspace-git",
];

/** Project fixed worker identities only; Docker paths, commands and credentials stay private. */
export function summarizeMcpWorkers(details) {
  const groups = new Map(MCP_WORKERS.map((server) => [server, []]));
  for (const detail of details) {
    if (
      !/^\/nova-mcp-[a-f0-9-]{36}$/.test(detail?.Name ?? "") ||
      detail?.Config?.User !== "1000:1000" ||
      detail?.HostConfig?.NetworkMode !== "none" ||
      detail?.HostConfig?.ReadonlyRootfs !== true
    )
      continue;
    const cmd = detail.Config.Cmd;
    let server;
    if (
      JSON.stringify(cmd) === JSON.stringify(["mcp-server-sequential-thinking"])
    )
      server = "sequential-thinking";
    else if (
      JSON.stringify(cmd) ===
      JSON.stringify(["mcp-server-filesystem", "/data/workspace"])
    )
      server = "filesystem";
    else if (
      JSON.stringify(cmd) ===
      JSON.stringify([
        "node",
        "/app/stack-control/mcp-proxy-stdio.mjs",
        "context7",
      ])
    )
      server = "context7";
    else if (
      Array.isArray(cmd) &&
      cmd.length === 5 &&
      cmd[0] === "/opt/git-mcp/bin/python" &&
      cmd[1] === "-m" &&
      cmd[2] === "mcp_server_git" &&
      cmd[3] === "--repository" &&
      /^\/data\/workspace\/[a-z0-9][a-z0-9-]{0,47}$/.test(cmd[4])
    )
      server = "workspace-git";
    if (server) groups.get(server).push(detail.State?.Status);
  }
  return MCP_WORKERS.map((server) => {
    const states = groups.get(server);
    const kinds = new Set(
      states.map((state) =>
        state === "running"
          ? "running"
          : ["created", "restarting"].includes(state)
            ? "starting"
            : "stopped",
      ),
    );
    return {
      server,
      state: !states.length
        ? "missing"
        : kinds.size > 1
          ? "mixed"
          : [...kinds][0],
      workerCount: states.length,
    };
  });
}

export function createStackControlServer({
  token = process.env.STACK_CONTROL_TOKEN ?? "",
  docker = dockerRequest,
  workspaceRoot = "/workspace-host",
} = {}) {
  const sandbox = createCodeSandbox({ docker, workspaceRoot });
  const send = (response, status, body) => {
    response.writeHead(status, {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(JSON.stringify(body));
  };
  const authorized = (request) =>
    /^[a-f0-9]{64}$/i.test(token) &&
    safeEqual(request.headers.authorization ?? "", `Bearer ${token}`);
  const allContainers = async () => {
    const filters = encodeURIComponent(
      JSON.stringify({
        name: [...Object.values(STATUS_SERVICES), "nova-mcp-"],
      }),
    );
    const rows = await docker(`/containers/json?all=1&filters=${filters}`);
    return Array.isArray(rows) ? rows : [];
  };
  const inspectService = async (service, containers) => {
    const containerName = STATUS_SERVICES[service];
    const row = containers.find((item) =>
      Array.isArray(item.Names)
        ? item.Names.includes(`/${containerName}`)
        : false,
    );
    if (!row)
      return {
        id: service,
        label: containerName,
        state: "missing",
        health: null,
        startedAt: null,
        revision: digest({ service, state: "missing" }),
      };
    const detail = await docker(
      `/containers/${encodeURIComponent(row.Id)}/json`,
    );
    const state = detail?.State?.Status ?? "unknown";
    const health = detail?.State?.Health?.Status ?? null;
    const startedAt = detail?.State?.StartedAt ?? "";
    return {
      id: service,
      label: containerName,
      state,
      health,
      startedAt,
      revision: digest({ id: row.Id, state, health, startedAt }),
    };
  };

  const server = http.createServer(async (request, response) => {
    const url = new URL(request.url ?? "/", "http://stack-control");
    if (request.method === "GET" && url.pathname === "/health") {
      send(response, 200, { ok: true });
      return;
    }
    if (!authorized(request)) {
      send(response, 401, { error: "unauthorized" });
      return;
    }
    try {
      if (
        request.method === "GET" &&
        url.pathname === "/services/node-red/logs"
      ) {
        if (url.search) {
          send(response, 400, { error: "invalid_request" });
          return;
        }
        send(response, 200, await readNodeRedLogs(docker));
        return;
      }
      if (request.method === "GET" && url.pathname === "/services") {
        const containers = await allContainers();
        const services = await Promise.all(
          Object.keys(STATUS_SERVICES).map((service) =>
            inspectService(service, containers),
          ),
        );
        const workerRows = containers
          .filter(
            (row) =>
              Array.isArray(row.Names) &&
              row.Names.some((name) => /^\/nova-mcp-[a-f0-9-]{36}$/.test(name)),
          )
          .slice(0, 64);
        let workersAvailable = true;
        const workerDetails = await Promise.all(
          workerRows.map(async (row) => {
            try {
              return await docker(
                `/containers/${encodeURIComponent(row.Id)}/json`,
              );
            } catch (error) {
              // Only confirmed disappearance permits a missing worker count.
              if (error?.message !== "Docker API status 404")
                workersAvailable = false;
              return null;
            }
          }),
        );
        send(response, 200, {
          services,
          ...(workersAvailable
            ? { mcpWorkers: summarizeMcpWorkers(workerDetails) }
            : {}),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/code/run") {
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 12 * 1024) {
            send(response, 413, { error: "request too large" });
            return;
          }
        }
        let input;
        try {
          input = JSON.parse(body);
        } catch {
          send(response, 400, { error: "invalid request" });
          return;
        }
        const result = await sandbox.run(input);
        send(response, 200, result);
        return;
      }

      const match = url.pathname.match(/^\/services\/([a-z-]+)\/restart$/);
      if (request.method === "POST" && match) {
        const service = match[1];
        if (!Object.hasOwn(STACK_SERVICES, service)) {
          send(response, 404, { error: "service not allowed" });
          return;
        }
        let body = "";
        for await (const chunk of request) {
          body += chunk;
          if (body.length > 2048) {
            send(response, 413, { error: "request too large" });
            return;
          }
        }
        let input;
        try {
          input = JSON.parse(body);
        } catch {
          send(response, 400, { error: "invalid request" });
          return;
        }
        if (
          !input ||
          Object.keys(input).some((key) => key !== "expectedRevision") ||
          typeof input.expectedRevision !== "string" ||
          !/^[a-f0-9]{64}$/.test(input.expectedRevision)
        ) {
          send(response, 400, { error: "invalid request" });
          return;
        }
        const containers = await allContainers();
        const current = await inspectService(service, containers);
        if (
          current.state !== "running" ||
          current.revision !== input.expectedRevision
        ) {
          send(response, 409, { error: "service state changed" });
          return;
        }
        const row = containers.find((item) =>
          Array.isArray(item.Names)
            ? item.Names.includes(`/${STACK_SERVICES[service]}`)
            : false,
        );
        await docker(
          `/containers/${encodeURIComponent(row.Id)}/restart?t=10`,
          "POST",
        );
        send(response, 200, { ok: true, service });
        return;
      }
      send(response, 404, { error: "not found" });
    } catch {
      send(response, 503, { error: "stack control unavailable" });
    }
  });
  const mcp = createMcpUpgradeHandler({
    sandbox: createMcpSandbox({ docker, workspaceRoot }),
    docker,
    authorized,
  });
  server.on("upgrade", mcp);
  server.closeMcpSessions = () => mcp.shutdown();
  server.on("close", () => {
    void mcp.shutdown().catch(() => {});
  });
  return server;
}

if (process.argv[1] && new URL(import.meta.url).pathname === process.argv[1]) {
  const server = createStackControlServer();
  const shutdown = () => {
    void server
      .closeMcpSessions()
      .catch(() => {
        console.warn("MCP sandbox cleanup failed during shutdown");
      })
      .finally(() => server.close(() => process.exit(0)));
  };
  process.once("SIGTERM", shutdown);
  process.once("SIGINT", shutdown);
  server.listen(Number(process.env.PORT ?? 8090), "0.0.0.0");
}

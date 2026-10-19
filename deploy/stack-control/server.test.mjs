import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import {
  createStackControlServer,
  STATUS_SERVICES,
  summarizeMcpWorkers,
  reapAbandonedMcpWorkers,
} from "./server.mjs";

const token = "a".repeat(64);
const liveContainers = Object.entries(STATUS_SERVICES).map(
  ([service, name]) => ({
    Id: `container-${service}`,
    Names: [`/${name}`],
  }),
);
const servers = [];
afterEach(async () => {
  await Promise.all(
    servers
      .splice(0)
      .map((server) => new Promise((resolve) => server.close(resolve))),
  );
});

async function start(docker) {
  const server = createStackControlServer({ token, docker });
  servers.push(server);
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${server.address().port}`;
}

const inspect = (path) => ({
  Id: path.split("/")[2],
  State: {
    Status: "running",
    StartedAt: "2026-10-11T00:00:00Z",
    Health: { Status: "healthy" },
  },
});

test("lists only fixed stack services and never returns container IDs", async () => {
  const base = await start(async (path) =>
    path.startsWith("/containers/json?all=1")
      ? [...liveContainers, { Id: "host-secret", Names: ["/unrelated"] }]
      : inspect(path),
  );
  const response = await fetch(`${base}/services`, {
    headers: { authorization: `Bearer ${token}` },
  });
  const body = await response.json();
  assert.equal(response.status, 200);
  assert.deepEqual(
    body.services.map((service) => service.id),
    Object.keys(STATUS_SERVICES),
  );
  assert.ok(body.services.every((service) => service.state === "running"));
  assert.doesNotMatch(JSON.stringify(body), /container-|host-secret/);
});

test("requires bearer token and rejects unknown service operations", async () => {
  const base = await start(async () => liveContainers);
  assert.equal((await fetch(`${base}/services`)).status, 401);
  const response = await fetch(`${base}/services/other/restart`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedRevision: "a".repeat(64) }),
  });
  assert.equal(response.status, 404);
});

test("restarts only the reviewed container after revision check", async () => {
  const calls = [];
  const base = await start(async (path, method = "GET") => {
    calls.push([path, method]);
    if (path.startsWith("/containers/json?all=1")) return liveContainers;
    if (method === "POST") return null;
    return inspect(path);
  });
  const status = await fetch(`${base}/services`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  const service = status.services.find((row) => row.id === "qdrant");
  const response = await fetch(`${base}/services/qdrant/restart`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ expectedRevision: service.revision }),
  });
  assert.equal(response.status, 200);
  assert.ok(
    calls.some(
      ([path, method]) =>
        path === "/containers/container-qdrant/restart?t=10" &&
        method === "POST",
    ),
  );
  assert.ok(calls.every(([path]) => !path.includes("host-secret")));
});

test("rejects stale state without restarting", async () => {
  let state = "running";
  const calls = [];
  const base = await start(async (path, method = "GET") => {
    calls.push([path, method]);
    if (path.startsWith("/containers/json?all=1")) return liveContainers;
    return { ...inspect(path), State: { Status: state, StartedAt: "changed" } };
  });
  const status = await fetch(`${base}/services`, {
    headers: { authorization: `Bearer ${token}` },
  }).then((response) => response.json());
  state = "exited";
  const response = await fetch(`${base}/services/mqtt/restart`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({
      expectedRevision: status.services.find((row) => row.id === "mqtt")
        .revision,
    }),
  });
  assert.equal(response.status, 409);
  assert.ok(calls.every(([, method]) => method !== "POST"));
});

test("worker summaries show lifecycle and duplicates without exposing Docker data", () => {
  const worker = (command, state = "running") => ({
    Name: "/nova-mcp-" + "a".repeat(36),
    Config: {
      User: "1000:1000",
      Cmd: command,
      Env: ["SECRET=private-fixture"],
    },
    HostConfig: { NetworkMode: "none", ReadonlyRootfs: true },
    State: { Status: state },
  });
  const result = summarizeMcpWorkers([
    worker(["mcp-server-filesystem", "/data/workspace"]),
    worker(["mcp-server-filesystem", "/data/workspace"], "created"),
    worker(["node", "/app/stack-control/mcp-proxy-stdio.mjs", "context7"]),
    {
      ...worker(["mcp-server-sequential-thinking"]),
      HostConfig: { NetworkMode: "host", ReadonlyRootfs: true },
    },
    null,
  ]);
  assert.deepEqual(
    result.find((row) => row.server === "filesystem"),
    { server: "filesystem", state: "mixed", workerCount: 2 },
  );
  assert.deepEqual(
    result.find((row) => row.server === "context7"),
    { server: "context7", state: "running", workerCount: 1 },
  );
  assert.equal(
    result.find((row) => row.server === "sequential-thinking").workerCount,
    0,
  );
  assert.doesNotMatch(
    JSON.stringify(result),
    /private-fixture|nova-mcp-|Cmd|Env|workspace\//,
  );
});

test("worker inspection failures remain unknown while confirmed disappearance permits missing", async () => {
  for (const message of ["Docker timeout", "Docker API status 404"]) {
    const base = await start(async (path) => {
      if (path.startsWith("/containers/json?all=1"))
        return [
          ...liveContainers,
          { Id: "worker", Names: [`/nova-mcp-${"a".repeat(36)}`] },
        ];
      if (path === "/containers/worker/json") throw new Error(message);
      return inspect(path);
    });
    const response = await fetch(`${base}/services`, {
      headers: { authorization: `Bearer ${token}` },
    });
    const body = await response.json();
    assert.equal(response.status, 200);
    if (message === "Docker timeout") assert.equal(body.mcpWorkers, undefined);
    else assert.ok(body.mcpWorkers.every((row) => row.state === "missing"));
  }
});

test("Node-RED logs require authentication and reject caller options before Docker", async () => {
  let calls = 0;
  const base = await start(async () => {
    calls++;
    return Buffer.alloc(0);
  });
  assert.equal((await fetch(`${base}/services/node-red/logs`)).status, 401);
  const headers = { authorization: `Bearer ${token}` };
  assert.equal(
    (await fetch(`${base}/services/node-red/logs?tail=999`, { headers }))
      .status,
    400,
  );
  assert.equal(calls, 0);
  const response = await fetch(`${base}/services/node-red/logs`, { headers });
  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    entries: [],
    limited: true,
    truncated: false,
  });
  assert.equal(calls, 1);
});

test("startup reaps only old never-started recognized MCP workers", async () => {
  const now = Date.now();
  const make = (n, changes = {}) => ({
    Id: String(n).repeat(64),
    Name: `/nova-mcp-${"a".repeat(36)}`,
    Created: new Date(now - 600_000).toISOString(),
    State: { Status: "created", Running: false },
    Config: { User: "1000:1000", Cmd: ["mcp-server-sequential-thinking"] },
    HostConfig: { NetworkMode: "none", ReadonlyRootfs: true, AutoRemove: true },
    ...changes,
  });
  const details = [
    make(1),
    make(2, { State: { Status: "running", Running: true } }),
    make(3, { Created: new Date(now).toISOString() }),
    make(4, { Config: { User: "1000:1000", Cmd: ["unrelated"] } }),
    make(5, { Name: "/unrelated" }),
  ];
  const removed = [];
  const docker = async (path, method) => {
    if (path.startsWith("/containers/json?"))
      return details.map((d) => ({ Id: d.Id, Names: [d.Name] }));
    const d = details.find((d) => path.includes(d.Id));
    if (method === "DELETE") {
      removed.push(d.Id);
      return;
    }
    return d;
  };
  assert.equal(await reapAbandonedMcpWorkers(docker, now), 1);
  assert.deepEqual(removed, [details[0].Id]);
});

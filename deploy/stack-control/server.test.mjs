import assert from "node:assert/strict";
import { once } from "node:events";
import { afterEach, test } from "node:test";
import { createStackControlServer, STATUS_SERVICES } from "./server.mjs";

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

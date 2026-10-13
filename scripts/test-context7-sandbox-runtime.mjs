import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import http from "node:http";
import crypto from "node:crypto";
import { spawnSync } from "node:child_process";
import { once } from "node:events";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { createMcpSandbox } from "../deploy/stack-control/mcp-sandbox.mjs";
import { createMcpUpgradeHandler } from "../deploy/stack-control/mcp-stream.mjs";
import { createContext7Relay } from "../deploy/stack-control/mcp-egress.mjs";
import { dockerRequest } from "../deploy/stack-control/server.mjs";

// Use an immutable, already cached image; never pull/build or touch active services.
const inspect = spawnSync(
  "docker",
  process.env.NOVA_MCP_SANDBOX_TEST_IMAGE
    ? [
        "image",
        "inspect",
        process.env.NOVA_MCP_SANDBOX_TEST_IMAGE,
        "--format",
        "{{.Id}}",
      ]
    : ["container", "inspect", "nova", "--format", "{{.Image}}"],
  { encoding: "utf8", timeout: 10_000 },
);
const imageId = inspect.stdout?.trim();
assert.ok(
  inspect.status === 0 && /^sha256:[a-f0-9]{64}$/.test(imageId),
  "A cached NOVA runtime image is required",
);
const image = await dockerRequest(`/images/${imageId}/json`);
assert.equal(image.Id, imageId);

function deadline(promise, milliseconds, label) {
  let timer;
  return Promise.race([
    promise,
    new Promise((_, reject) => {
      timer = setTimeout(
        () => reject(new Error(`${label} timed out`)),
        milliseconds,
      );
    }),
  ]).finally(() => clearTimeout(timer));
}

// Docker's JSON adapter cannot upload archives. Upload only the public wrapper
// to an owned, never-started image preparation container, not the real sandbox.
function injectWrapper(containerId) {
  const content = fs.readFileSync(
    new URL("../deploy/stack-control/mcp-proxy-stdio.mjs", import.meta.url),
  );
  function tarHeader(name, size = 0, directory = false) {
    const header = Buffer.alloc(512);
    header.write(name, 0);
    for (const [offset, length, value] of [
      [100, 8, directory ? 0o755 : 0o644],
      [108, 8, 0],
      [116, 8, 0],
      [124, 12, size],
      [136, 12, 0],
    ])
      header.write(value.toString(8).padStart(length - 1, "0") + "\0", offset);
    header.fill(32, 148, 156);
    header.write(directory ? "5" : "0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    const checksum = header.reduce((sum, byte) => sum + byte, 0);
    header.write(checksum.toString(8).padStart(6, "0") + "\0 ", 148);
    return header;
  }
  const archive = Buffer.concat([
    tarHeader("app/", 0, true),
    tarHeader("app/stack-control/", 0, true),
    tarHeader("app/stack-control/mcp-proxy-stdio.mjs", content.length),
    content,
    Buffer.alloc(((512 - (content.length % 512)) % 512) + 1024),
  ]);
  return new Promise((resolve, reject) => {
    const request = http.request(
      {
        socketPath: "/var/run/docker.sock",
        path: `/containers/${containerId}/archive?path=/`,
        method: "PUT",
        headers: {
          "content-type": "application/x-tar",
          "content-length": archive.length,
        },
        timeout: 10_000,
      },
      (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("error", reject);
        response.on("end", () =>
          response.statusCode === 200
            ? resolve()
            : reject(
                new Error(
                  `Wrapper archive upload failed (${response.statusCode}): ${Buffer.concat(chunks).toString("utf8")}`,
                ),
              ),
        );
      },
    );
    request.on("timeout", () =>
      request.destroy(new Error("Wrapper archive upload timed out")),
    );
    request.on("error", reject);
    request.end(archive);
  });
}

function stdoutFrames(bytes) {
  const chunks = [];
  let offset = 0;
  while (offset < bytes.length) {
    assert.ok(offset + 8 <= bytes.length);
    const stream = bytes[offset];
    const length = bytes.readUInt32BE(offset + 4);
    offset += 8;
    assert.ok(offset + length <= bytes.length);
    if (stream === 1) chunks.push(bytes.subarray(offset, offset + length));
    offset += length;
  }
  return Buffer.concat(chunks).toString("utf8");
}

const dataRoot = fs.mkdtempSync(
  path.join(os.tmpdir(), "nova-context7-runtime-"),
);
const workspaceRoot = path.join(dataRoot, "workspace");
const relayRoot = path.join(dataRoot, "mcp-relay");
const context7Root = path.join(relayRoot, "context7");
const socketPath = path.join(context7Root, "relay.sock");
const servers = [];
const sockets = new Set();
const upstreamRequests = [];
const intendedRequests = [];
const libraryId = "/microsoft/typescript";
const query = "Explain TypeScript discriminated unions";
const docs =
  "NOVA Context7 runtime fixture: TypeScript discriminated unions narrow by a literal tag.";
let fixtureError;
let runtimeError;
let containerId;
let preparationId;
let runtimeImageId;
let stream;
let bridge;
let sandbox;
let runError;
const cleanupErrors = [];

function track(server) {
  servers.push(server);
  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });
  return server;
}
async function listen(server, ...args) {
  const listening = once(server, "listening");
  server.listen(...args);
  await deadline(listening, 5000, "Fixture listen");
}

try {
  // Cached images can predate the wrapper. A disposable COPY-like layer lets
  // the actual runtime keep its exact fixed command and read-only rootfs.
  const preparation = await dockerRequest(
    `/containers/create?name=nova-context7-image-${crypto.randomUUID()}`,
    "POST",
    {
      Image: imageId,
      Entrypoint: [],
      Cmd: ["true"],
      Env: [],
      HostConfig: {
        NetworkMode: "none",
        ReadonlyRootfs: false,
        CapDrop: ["ALL"],
        SecurityOpt: ["no-new-privileges:true"],
        Tmpfs: { "/data": "ro,noexec,nosuid,nodev,size=1m" },
        Mounts: [],
      },
    },
  );
  preparationId = preparation.Id;
  assert.ok(typeof preparationId === "string" && preparationId);
  await injectWrapper(preparationId);
  const preparedState = await dockerRequest(
    `/containers/${preparationId}/json`,
  );
  assert.equal(preparedState.State.Status, "created");
  assert.equal(preparedState.State.Running, false);
  assert.equal(preparedState.Image, imageId);
  const committed = await dockerRequest(
    `/commit?container=${preparationId}&pause=0`,
    "POST",
    undefined,
    { timeoutMs: 30_000 },
  );
  runtimeImageId = committed.Id;
  assert.ok(/^sha256:[a-f0-9]{64}$/.test(runtimeImageId));
  assert.notEqual(runtimeImageId, imageId);
  assert.equal(
    (await dockerRequest(`/images/${runtimeImageId}/json`)).Id,
    runtimeImageId,
  );
  fs.mkdirSync(workspaceRoot, { mode: 0o700 });
  fs.chownSync(workspaceRoot, 1000, 1000);
  fs.mkdirSync(context7Root, { recursive: true, mode: 0o755 });
  const fixture = track(
    http.createServer((request, response) => {
      try {
        const url = new URL(request.url, "http://fixture");
        upstreamRequests.push({
          path: url.pathname,
          params: Object.fromEntries(url.searchParams),
          headers: request.headers,
        });
        assert.equal(request.method, "GET");
        assert.ok(
          ["/api/v2/libs/search", "/api/v2/context"].includes(url.pathname),
        );
        assert.equal(request.headers.host, "context7.com");
        assert.equal(request.headers.accept, "application/json, text/plain");
        assert.equal(request.headers["user-agent"], "nova-context7-relay");
        assert.deepEqual(Object.keys(request.headers).sort(), [
          "accept",
          "connection",
          "host",
          "user-agent",
        ]);
        response.setHeader(
          "content-type",
          url.pathname.endsWith("search") ? "application/json" : "text/plain",
        );
        // Context7 4.3.0 formats SearchResponse.results using these exact fields.
        response.end(
          url.pathname.endsWith("search")
            ? JSON.stringify({
                results: [
                  {
                    id: libraryId,
                    title: "TypeScript",
                    description: "TypeScript language documentation",
                    totalSnippets: 12,
                    trustScore: 9,
                    benchmarkScore: 95,
                    versions: [],
                  },
                ],
              })
            : docs,
        );
      } catch (error) {
        fixtureError = error;
        response.writeHead(500);
        response.end("Fixture assertion failed");
      }
    }),
  );
  await listen(fixture, 0, "127.0.0.1");
  const relay = track(
    createContext7Relay({
      request(options, callback) {
        try {
          assert.equal(options.protocol, "https:");
          assert.equal(options.hostname, "context7.com");
          assert.equal(options.port, 443);
          assert.equal(options.servername, "context7.com");
          assert.equal(options.rejectUnauthorized, true);
          assert.equal(options.agent, false);
          assert.equal(options.method, "GET");
          assert.deepEqual(options.headers, {
            Host: "context7.com",
            Accept: "application/json, text/plain",
            "User-Agent": "nova-context7-relay",
          });
          intendedRequests.push(options.path);
        } catch (error) {
          fixtureError = error;
          throw error;
        }
        return http.request(
          {
            hostname: "127.0.0.1",
            port: fixture.address().port,
            method: options.method,
            path: options.path,
            headers: options.headers,
            agent: false,
          },
          callback,
        );
      },
    }),
  );
  await listen(relay, socketPath);
  fs.chownSync(socketPath, 1000, 1000);
  fs.chmodSync(socketPath, 0o660);
  const docker = async (url, method = "GET", body, options) => {
    if (url.startsWith("/containers/json?all=1"))
      return [
        { Id: "fixture-nova", Names: ["/nova"] },
        { Id: "fixture-broker", Names: ["/nova-stack-control"] },
      ];
    if (url === "/containers/fixture-nova/json")
      return {
        Image: runtimeImageId,
        Mounts: [{ Type: "bind", Source: dataRoot, Destination: "/data" }],
      };
    if (url === "/containers/fixture-broker/json")
      return {
        Mounts: [
          {
            Type: "bind",
            Source: workspaceRoot,
            Destination: "/workspace-host",
          },
          { Type: "bind", Source: relayRoot, Destination: "/relay-host" },
        ],
      };
    try {
      return await dockerRequest(url, method, body, options);
    } catch (error) {
      runtimeError = error;
      throw error;
    }
  };
  sandbox = createMcpSandbox({ docker, workspaceRoot, relayRoot });
  const token = crypto.randomBytes(32).toString("hex");
  const broker = track(http.createServer());
  bridge = createMcpUpgradeHandler({
    sandbox: {
      async prepare(input) {
        try {
          assert.deepEqual(input, { server: "context7" });
          const prepared = await sandbox.prepare(input);
          containerId = prepared.containerId;
          return prepared;
        } catch (error) {
          runtimeError = error;
          throw error;
        }
      },
      close: (id) => sandbox.close(id),
    },
    docker,
    authorized: (request) =>
      request.headers.authorization === `Bearer ${token}`,
  });
  broker.on("upgrade", bridge);
  await listen(broker, 0, "127.0.0.1");
  stream = await deadline(
    new Promise((resolve, reject) => {
      const request = http.request({
        hostname: "127.0.0.1",
        port: broker.address().port,
        path: "/mcp/offline?server=context7",
        headers: {
          authorization: `Bearer ${token}`,
          connection: "Upgrade",
          upgrade: "nova-mcp",
        },
        timeout: 25_000,
      });
      request.on("error", reject);
      request.on("timeout", () =>
        request.destroy(new Error("Broker handshake timed out")),
      );
      request.on("response", (response) => {
        response.resume();
        reject(
          new Error(
            `Broker handshake failed (${response.statusCode}): ${runtimeError?.message ?? "attachment/start unavailable"}`,
          ),
        );
      });
      request.on("upgrade", (response, socket, head) => {
        stream = socket;
        if (
          response.statusCode !== 101 ||
          response.headers.upgrade !== "nova-mcp"
        ) {
          socket.destroy();
          reject(new Error("Invalid broker upgrade"));
          return;
        }
        socket.pause();
        if (head.length) socket.unshift(head);
        resolve(socket);
      });
      request.end();
    }),
    30_000,
    "Broker upgrade",
  );
  const pending = new Map();
  const readBuffer = new ReadBuffer();
  const failPending = (error) => {
    for (const { reject } of pending.values()) reject(error);
    pending.clear();
  };
  stream.on("error", failPending);
  stream.on("close", () => failPending(new Error("Broker MCP stream closed")));
  stream.on("data", (chunk) => {
    try {
      readBuffer.append(chunk);
      let message;
      while ((message = readBuffer.readMessage()) !== null) {
        const waiter = pending.get(message.id);
        if (!waiter) continue;
        pending.delete(message.id);
        if (message.error)
          waiter.reject(
            new Error(`MCP request failed: ${JSON.stringify(message.error)}`),
          );
        else waiter.resolve(message.result);
      }
    } catch (error) {
      failPending(error);
    }
  });
  stream.resume();
  let nextId = 0;
  async function rpc(method, params) {
    const id = ++nextId;
    try {
      return await deadline(
        new Promise((resolve, reject) => {
          pending.set(id, { resolve, reject });
          stream.write(
            JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n",
          );
        }),
        25_000,
        method,
      );
    } finally {
      pending.delete(id);
    }
  }
  const initialized = await rpc("initialize", {
    protocolVersion: "2024-11-05",
    capabilities: {},
    clientInfo: { name: "nova-context7-runtime-test", version: "1" },
  });
  assert.ok(initialized.serverInfo);
  stream.write(
    JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) +
      "\n",
  );
  const listed = await rpc("tools/list", {});
  for (const name of ["resolve-library-id", "query-docs"])
    assert.ok(listed.tools.some((tool) => tool.name === name));
  const resolved = await rpc("tools/call", {
    name: "resolve-library-id",
    arguments: { query, libraryName: "TypeScript" },
  });
  assert.notEqual(resolved.isError, true);
  const resultText = resolved.content
    .filter((item) => item.type === "text")
    .map((item) => item.text)
    .join("\n");
  assert.ok(
    resultText.includes(`Context7-compatible library ID: ${libraryId}`),
    "Actual library resolution must return the fixture ID",
  );
  const queried = await rpc("tools/call", {
    name: "query-docs",
    arguments: { query, libraryId },
  });
  assert.notEqual(queried.isError, true);
  assert.ok(
    queried.content.some(
      (item) => item.type === "text" && item.text.includes(docs),
    ),
    "Actual query-docs must return fixture documentation",
  );
  if (fixtureError) throw fixtureError;
  assert.equal(intendedRequests.length, 2);
  assert.deepEqual(
    upstreamRequests.map(({ path, params }) => ({ path, params })),
    [
      {
        path: "/api/v2/libs/search",
        params: { query, libraryName: "TypeScript" },
      },
      { path: "/api/v2/context", params: { query, libraryId } },
    ],
  );
  const state = await dockerRequest(`/containers/${containerId}/json`);
  assert.equal(state.Image, runtimeImageId);
  assert.equal(state.Config.User, "1000:1000");
  assert.deepEqual(state.Config.Cmd, [
    "node",
    "/app/stack-control/mcp-proxy-stdio.mjs",
    "context7",
  ]);
  assert.equal(state.HostConfig.NetworkMode, "none");
  assert.equal(state.HostConfig.ReadonlyRootfs, true);
  assert.deepEqual(
    state.Mounts.map(({ Type, Source, Destination, RW }) => ({
      Type,
      Source,
      Destination,
      RW,
    })),
    [
      {
        Type: "bind",
        Source: context7Root,
        Destination: "/run/nova-mcp-relay",
        RW: false,
      },
    ],
  );
  const probe = `
    const fs=require('node:fs'),net=require('node:net'),os=require('node:os');
    function connect(host){return new Promise(resolve=>{const socket=net.connect({host,port:443});const finish=value=>{socket.destroy();resolve(value)};socket.setTimeout(1000,()=>finish(false));socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));});}
    (async()=>{const root=fs.readFileSync('/proc/self/mountinfo','utf8').split('\\n').find(line=>line.split(' ')[4]==='/');const socket=fs.statSync('/run/nova-mcp-relay/relay.sock');console.log(JSON.stringify({uid:process.getuid(),network:Object.keys(os.networkInterfaces()).sort(),rootReadOnly:root?.split(' ')[5]?.split(',').includes('ro')===true,privateData:fs.readdirSync('/data'),relayFiles:fs.readdirSync('/run/nova-mcp-relay'),relaySocket:socket.isSocket(),relayUid:socket.uid,relayMode:socket.mode&0o777,hasModelCredential:Object.keys(process.env).some(key=>/API_KEY|TOKEN|SECRET|PASSWORD/.test(key)),directInternet:await connect('1.1.1.1'),providerConnection:await connect('context7.com')}));})().catch(()=>{console.error('Runtime probe failed');process.exitCode=1;});
  `;
  const execution = await dockerRequest(
    `/containers/${containerId}/exec`,
    "POST",
    { AttachStdout: true, AttachStderr: true, Cmd: ["node", "-e", probe] },
  );
  const output = await dockerRequest(
    `/exec/${execution.Id}/start`,
    "POST",
    { Detach: false, Tty: false },
    { raw: true, timeoutMs: 10_000, maxBytes: 32_768 },
  );
  assert.equal((await dockerRequest(`/exec/${execution.Id}/json`)).ExitCode, 0);
  assert.deepEqual(JSON.parse(stdoutFrames(output).trim()), {
    uid: 1000,
    network: ["lo"],
    rootReadOnly: true,
    privateData: [],
    relayFiles: ["relay.sock"],
    relaySocket: true,
    relayUid: 1000,
    relayMode: 0o660,
    hasModelCredential: false,
    directInternet: false,
    providerConnection: false,
  });
} catch (error) {
  runError = error;
} finally {
  stream?.destroy();
  try {
    if (bridge) await deadline(bridge.shutdown(), 20_000, "Broker cleanup");
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (containerId)
      await deadline(sandbox.close(containerId), 10_000, "Container cleanup");
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (preparationId)
      await dockerRequest(`/containers/${preparationId}?force=1&v=1`, "DELETE");
  } catch (error) {
    cleanupErrors.push(error);
  }
  try {
    if (runtimeImageId)
      await dockerRequest(`/images/${runtimeImageId}`, "DELETE");
  } catch (error) {
    cleanupErrors.push(error);
  }
  for (const socket of sockets) socket.destroy();
  for (const server of servers.reverse()) {
    server.closeAllConnections?.();
    try {
      await deadline(
        new Promise((resolve) => server.close(resolve)),
        5000,
        "Fixture cleanup",
      );
    } catch (error) {
      cleanupErrors.push(error);
    }
  }
  try {
    fs.rmSync(dataRoot, { recursive: true, force: true });
  } catch (error) {
    cleanupErrors.push(error);
  }
}
if (cleanupErrors.length)
  throw new AggregateError(
    runError ? [runError, ...cleanupErrors] : cleanupErrors,
    "Context7 runtime cleanup failed",
  );
if (runError) throw runError;
console.log(
  "Real Context7 broker stdio, Unix relay, tool calls and offline container isolation passed.",
);

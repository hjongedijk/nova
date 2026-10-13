import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import http from "node:http";
import crypto from "node:crypto";
import { once } from "node:events";
import { ReadBuffer } from "@modelcontextprotocol/sdk/shared/stdio.js";
import { createMcpSandbox } from "../deploy/stack-control/mcp-sandbox.mjs";
import { createMcpUpgradeHandler } from "../deploy/stack-control/mcp-stream.mjs";
import { dockerRequest } from "../deploy/stack-control/server.mjs";

// Reuse a cached NOVA image. This gate never changes the running stack or pulls an image.
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
  { encoding: "utf8" },
);
const imageId = inspect.stdout.trim();
if (inspect.status !== 0 || !/^sha256:[a-f0-9]{64}$/.test(imageId))
  throw new Error("A cached NOVA runtime image is required");

const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "nova-mcp-runtime-"));
const workspaceRoot = path.join(dataRoot, "workspace");
fs.mkdirSync(workspaceRoot, { mode: 0o700 });
fs.chownSync(workspaceRoot, 1000, 1000);
const docker = async (url, method = "GET", body, options) => {
  if (url.startsWith("/containers/json?all=1"))
    return [
      { Id: "fixture-nova", Names: ["/nova"] },
      { Id: "fixture-broker", Names: ["/nova-stack-control"] },
    ];
  if (url === "/containers/fixture-nova/json")
    return {
      Image: imageId,
      Mounts: [{ Type: "bind", Source: dataRoot, Destination: "/data" }],
    };
  if (url === "/containers/fixture-broker/json")
    return {
      Mounts: [
        { Type: "bind", Source: workspaceRoot, Destination: "/workspace-host" },
      ],
    };
  return dockerRequest(url, method, body, options);
};

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

const sandbox = createMcpSandbox({ docker, workspaceRoot });
let containerId;
let stream;
const token = crypto.randomBytes(32).toString("hex");
const server = http.createServer();
const bridge = createMcpUpgradeHandler({
  sandbox: {
    prepare: async (input) => {
      const prepared = await sandbox.prepare(input);
      containerId = prepared.containerId;
      return prepared;
    },
    close: (id) => sandbox.close(id),
  },
  docker,
  authorized: (request) => request.headers.authorization === `Bearer ${token}`,
});
server.on("upgrade", bridge);
try {
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  await new Promise((resolve, reject) => {
    const request = http.request({
      hostname: "127.0.0.1",
      port: server.address().port,
      path: "/mcp/offline?server=sequential-thinking",
      headers: {
        authorization: `Bearer ${token}`,
        connection: "Upgrade",
        upgrade: "nova-mcp",
      },
    });
    const timeout = setTimeout(() => {
      request.destroy();
      reject(new Error("MCP broker runtime handshake timed out"));
    }, 25_000);
    const fail = () => {
      clearTimeout(timeout);
      reject(new Error("MCP broker runtime handshake failed"));
    };
    request.on("error", fail);
    request.on("response", (response) => {
      response.resume();
      fail();
    });
    request.on("upgrade", (response, socket, head) => {
      stream = socket;
      if (
        response.statusCode !== 101 ||
        response.headers.upgrade !== "nova-mcp"
      ) {
        socket.destroy();
        fail();
        return;
      }
      const buffer = new ReadBuffer();
      const receive = (chunk) => {
        try {
          buffer.append(chunk);
          let message;
          while ((message = buffer.readMessage()) !== null) {
            if (message.id === 1) {
              assert.ok(message.result?.serverInfo);
              socket.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  method: "notifications/initialized",
                }) + "\n",
              );
              socket.write(
                JSON.stringify({
                  jsonrpc: "2.0",
                  id: 2,
                  method: "tools/list",
                  params: {},
                }) + "\n",
              );
            } else if (message.id === 2) {
              assert.ok(
                message.result?.tools?.some(
                  (tool) => tool.name === "sequentialthinking",
                ),
              );
              clearTimeout(timeout);
              resolve();
            }
          }
        } catch {
          fail();
        }
      };
      socket.on("error", fail);
      socket.on("data", receive);
      if (head.length) receive(head);
      socket.write(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 1,
          method: "initialize",
          params: {
            protocolVersion: "2024-11-05",
            capabilities: {},
            clientInfo: { name: "nova-runtime-test", version: "1" },
          },
        }) + "\n",
      );
    });
    request.end();
  });
  const probe = `
    const fs = require('node:fs');
    const net = require('node:net');
    const os = require('node:os');
    const { spawn } = require('node:child_process');
    async function connect(host, port) {
      return new Promise(resolve => {
        const socket = net.connect({host, port});
        const finish = connected => { socket.destroy(); resolve(connected); };
        socket.setTimeout(1000, () => finish(false));
        socket.once('connect', () => finish(true));
        socket.once('error', () => finish(false));
      });
    }
    async function handshake() {
      return new Promise((resolve, reject) => {
        const child = spawn('mcp-server-sequential-thinking', [], {stdio:['pipe','pipe','ignore']});
        const timer = setTimeout(() => { child.kill(); reject(new Error('MCP handshake timeout')); }, 5000);
        let text = '';
        child.on('error', reject);
        child.stdout.on('data', chunk => {
          text += chunk;
          for (const line of text.split('\\n')) {
            if (!line.trim()) continue;
            try {
              const message = JSON.parse(line);
              if (message.id !== 1) continue;
              clearTimeout(timer);
              child.kill();
              resolve(Boolean(message.result?.serverInfo));
              return;
            } catch {}
          }
        });
        child.stdin.end(JSON.stringify({jsonrpc:'2.0',id:1,method:'initialize',params:{protocolVersion:'2024-11-05',capabilities:{},clientInfo:{name:'nova-isolation-test',version:'1'}}})+'\\n');
      });
    }
    (async () => {
      const root = fs.readFileSync('/proc/self/mountinfo','utf8').split('\\n').find(line => line.split(' ')[4] === '/');
      console.log(JSON.stringify({
        uid:process.getuid(),
        network:Object.keys(os.networkInterfaces()).sort(),
        rootReadOnly:root?.split(' ')[5]?.split(',').includes('ro')===true,
        privateData:fs.readdirSync('/data'),
        hasModelCredential:Boolean(process.env.OMNIROUTE_API_KEY || process.env.OPENAI_API_KEY),
        directInternet:await connect('1.1.1.1',443),
        providerConnection:await connect('api.openai.com',443),
        mcpHandshake:await handshake(),
      }));
    })().catch(() => { console.error('Runtime proof failed'); process.exitCode=1; });
  `;
  const execution = await dockerRequest(
    `/containers/${containerId}/exec`,
    "POST",
    {
      AttachStdout: true,
      AttachStderr: true,
      Cmd: ["node", "-e", probe],
    },
  );
  const output = await dockerRequest(
    `/exec/${execution.Id}/start`,
    "POST",
    { Detach: false, Tty: false },
    { raw: true, timeoutMs: 10_000, maxBytes: 32_768 },
  );
  const executionState = await dockerRequest(`/exec/${execution.Id}/json`);
  assert.equal(executionState.ExitCode, 0, "Runtime probe failed");
  assert.deepEqual(JSON.parse(stdoutFrames(output).trim()), {
    uid: 1000,
    network: ["lo"],
    rootReadOnly: true,
    privateData: [],
    hasModelCredential: false,
    directInternet: false,
    providerConnection: false,
    mcpHandshake: true,
  });
  console.log(
    "Real broker stream, MCP handshake and offline container isolation passed.",
  );
} finally {
  stream?.destroy();
  await new Promise((resolve) => server.close(resolve));
  if (containerId) await sandbox.close(containerId);
  fs.rmSync(dataRoot, { recursive: true, force: true });
}

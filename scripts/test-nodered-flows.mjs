import assert from "node:assert/strict";
import {
  chmodSync,
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";
import { createServer } from "node:http";

const image = process.env.NOVA_NODE_RED_TEST_IMAGE || "nodered/node-red:4.1";
const source = resolve("deploy/nodered/flows.json");
const seed = resolve("deploy/nodered");
const flows = JSON.parse(readFileSync(source, "utf8"));
assert.ok(Array.isArray(flows), "flows.json must contain a JSON array");
const generatedFixture = [
  {
    id: "nova-generated-notify-e2e-test",
    type: "tab",
    label: "Generated NOVA notification transport test",
    disabled: false,
  },
  {
    id: "nova-generated-notify-inject-test",
    type: "inject",
    z: "nova-generated-notify-e2e-test",
    name: "Send fixture notification once",
    props: [{ p: "payload" }],
    repeat: "",
    crontab: "",
    once: true,
    onceDelay: 0.1,
    topic: "",
    payload:
      '{"title":"Node-RED testmelding","detail":"Transportcheck","severity":"warning"}',
    payloadType: "json",
    wires: [["nova-generated-notify-node-test"]],
  },
  {
    id: "nova-generated-notify-node-test",
    type: "nova-notify",
    z: "nova-generated-notify-e2e-test",
    name: "Send fixture notification to NOVA API",
    wires: [[]],
  },
  {
    id: "nova-generated-alert-test",
    type: "tab",
    label: "Generated alert import test",
    disabled: false,
  },
  {
    id: "nova-generated-catch-test",
    type: "catch",
    z: "nova-generated-alert-test",
    name: "NOVA generated error alert",
    uncaught: false,
    wires: [["nova-generated-change-test"]],
  },
  {
    id: "nova-generated-change-test",
    type: "change",
    z: "nova-generated-alert-test",
    rules: [
      {
        t: "set",
        p: "payload",
        pt: "msg",
        to: '{"title":"Backup: fout","detail":($exists(error.source.name)?error.source.name:"Een node") & ": " & ($exists(error.message)?$substring(error.message,0,160):"Er is een fout opgetreden."),"severity":"warning"}',
        tot: "jsonata",
      },
    ],
    wires: [["nova-generated-notify-test"]],
  },
  {
    id: "nova-generated-notify-test",
    type: "nova-notify",
    z: "nova-generated-alert-test",
    name: "Send alert to NOVA",
    wires: [[]],
  },
  {
    id: "nova-generated-offline-test",
    type: "tab",
    label: "Generated offline import test",
    disabled: false,
  },
  {
    id: "nova-generated-offline-source-test",
    type: "inject",
    z: "nova-generated-offline-test",
    name: "Status scope fixture",
    wires: [[]],
  },
  {
    id: "nova-generated-status-test",
    type: "status",
    z: "nova-generated-offline-test",
    name: "NOVA generated alert_on_offline",
    scope: ["nova-generated-offline-source-test"],
    wires: [["nova-generated-switch-test"]],
  },
  {
    id: "nova-generated-switch-test",
    type: "switch",
    z: "nova-generated-offline-test",
    name: "Filter offline status",
    property: "status.text",
    propertyType: "msg",
    rules: [
      {
        t: "regex",
        v: "disconnected|offline|error",
        vt: "str",
        case: true,
      },
    ],
    checkall: "true",
    repair: false,
    outputs: 1,
    wires: [["nova-generated-offline-change-test"]],
  },
  {
    id: "nova-generated-offline-change-test",
    type: "change",
    z: "nova-generated-offline-test",
    name: "Format offline alert",
    rules: [
      {
        t: "set",
        p: "payload",
        pt: "msg",
        to: '{"title":"Backup: offline","detail":($exists(status.source.name)?status.source.name:"Een node") & ": " & ($exists(status.text)?$substring(status.text,0,160):"offline"),"severity":"warning"}',
        tot: "jsonata",
      },
    ],
    wires: [["nova-generated-offline-notify-test"]],
  },
  {
    id: "nova-generated-offline-notify-test",
    type: "nova-notify",
    z: "nova-generated-offline-test",
    name: "Send offline alert to NOVA",
    wires: [[]],
  },
  {
    id: "nova-generated-briefing-test",
    type: "tab",
    label: "Generated briefing import test",
    disabled: false,
  },
  {
    id: "nova-generated-briefing-node-test",
    type: "nova-briefing",
    z: "nova-generated-briefing-test",
    name: "NOVA generated morning_briefing",
    kind: "morning_briefing",
    time: "",
    timezone: "Europe/Amsterdam",
    wires: [[]],
  },
];
const expectedIds = [...flows, ...generatedFixture]
  .map((flow) => flow?.id)
  .filter(Boolean);
assert.equal(
  expectedIds.length,
  flows.length + generatedFixture.length,
  "every seed and generated fixture node needs an id",
);

const data = mkdtempSync(join(tmpdir(), "nova-node-red-flows-"));
chmodSync(data, 0o777);
let container = "";
const eventToken = "nova-node-red-e2e-test-token-0123456789abcdef";
let receivedEvent;
const eventServer = createServer((request, response) => {
  const chunks = [];
  request.on("data", (chunk) => chunks.push(chunk));
  request.on("end", () => {
    if (
      request.method !== "POST" ||
      request.url !== "/api/integrations/node-red/events" ||
      request.headers.authorization !== `Bearer ${eventToken}`
    ) {
      response.writeHead(401).end();
      return;
    }
    try {
      receivedEvent = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(202, { "content-type": "application/json" });
      response.end('{"accepted":true}');
    } catch {
      response.writeHead(400).end();
    }
  });
});
function docker(args) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout: 30_000,
  });
  if (result.status !== 0)
    throw new Error(result.stderr.trim() || `docker ${args[0]} failed`);
  return result.stdout.trim();
}

try {
  await new Promise((resolve, reject) => {
    eventServer.once("error", reject);
    eventServer.listen(0, "0.0.0.0", resolve);
  });
  const eventPort = eventServer.address().port;
  copyFileSync(source, join(data, "flows.json"));
  const fixtureFile = join(data, "flows.json");
  const fixture = JSON.parse(readFileSync(fixtureFile, "utf8"));
  fixture.push(...generatedFixture);
  writeFileSync(fixtureFile, JSON.stringify(fixture, null, 2));
  container = docker([
    "run",
    "--detach",
    "--rm",
    "--publish",
    "127.0.0.1::1880",
    "--add-host",
    "host.docker.internal:host-gateway",
    "--env",
    `NOVA_API_URL=http://host.docker.internal:${eventPort}`,
    "--env",
    `NODE_RED_EVENT_TOKEN=${eventToken}`,
    "--mount",
    `type=bind,source=${data},target=/data`,
    "--mount",
    `type=bind,source=${seed},target=/opt/nova/nodered-seed,readonly`,
    "--entrypoint",
    "/bin/sh",
    image,
    "/opt/nova/nodered-seed/seed-entrypoint.sh",
  ]);
  const published = docker(["port", container, "1880/tcp"])
    .split("\n")
    .map((line) => line.trim())
    .find((line) => line.startsWith("127.0.0.1:"));
  assert.ok(published, "Node-RED did not publish its local test port");
  const url = `http://${published}`;
  const deadline = Date.now() + 60_000;
  let loaded = false;
  let lastError = "not ready";
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`${url}/flows`, {
        headers: { "Node-RED-API-Version": "v2" },
        signal: AbortSignal.timeout(2000),
      });
      if (response.ok) {
        const body = await response.json();
        const actual = Array.isArray(body)
          ? body.map((flow) => flow?.id)
          : Array.isArray(body?.flows)
            ? body.flows.map((flow) => flow?.id)
            : [];
        if (expectedIds.every((id) => actual.includes(id))) {
          loaded = true;
          break;
        }
        lastError = "Node-RED started without all expected flow IDs";
      } else lastError = `Node-RED Admin API returned ${response.status}`;
    } catch (error) {
      lastError = error instanceof Error ? error.message : "not ready";
    }
    await delay(500);
  }
  assert.ok(loaded, lastError);
  const nodesResponse = await fetch(`${url}/nodes`, {
    headers: {
      "Node-RED-API-Version": "v2",
      accept: "application/json",
    },
    signal: AbortSignal.timeout(3000),
  });
  assert.ok(
    nodesResponse.ok,
    `Node-RED /nodes returned ${nodesResponse.status}`,
  );
  const nodeTypes = await nodesResponse.text();
  const missing = [
    "nova-say",
    "nova-ask",
    "nova-notify",
    "nova-event",
    "nova-briefing",
  ].filter((type) => !nodeTypes.includes(type));
  if (missing.length) {
    console.error(docker(["logs", "--tail", "80", container]));
    console.error(
      docker([
        "exec",
        container,
        "sh",
        "-c",
        "cat /data/package.json; ls -la /data/node_modules/node-red-contrib-nova",
      ]),
    );
  }
  assert.deepEqual(
    missing,
    [],
    `Node-RED did not register: ${missing.join(", ")}`,
  );
  const eventDeadline = Date.now() + 15_000;
  while (!receivedEvent && Date.now() < eventDeadline) await delay(100);
  assert.deepEqual(receivedEvent, {
    type: "alert",
    title: "Node-RED testmelding",
    detail: "Transportcheck",
    severity: "warning",
  });
  console.log(
    `Node-RED imported ${expectedIds.length} flow nodes, registered all five NOVA nodes, and delivered a notification to the NOVA API boundary.`,
  );
} finally {
  if (container) spawnSync("docker", ["stop", container], { encoding: "utf8" });
  await new Promise((resolve) => eventServer.close(resolve));
  try {
    // Run after shutdown so the real UID-1000 image cannot create another file.
    // Only this test's temporary bind mount is exposed; never follow symlinks.
    docker([
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--user=0:0",
      "--mount",
      `type=bind,source=${data},target=/data`,
      "--entrypoint=chown",
      image,
      "-hR",
      `${process.getuid()}:${process.getgid()}`,
      "/data",
    ]);
  } catch (error) {
    console.error(
      `Node-RED fixture ownership cleanup warning: ${error.message}`,
    );
  }
  rmSync(data, { recursive: true, force: true });
}

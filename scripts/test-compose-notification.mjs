import assert from "node:assert/strict";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { setTimeout as delay } from "node:timers/promises";

const root = resolve(".");
const temp = mkdtempSync(join(tmpdir(), "nova-compose-notification-"));
const token = "nova-compose-notification-test-token-0123456789";
const helperToken = "nova-compose-helper-test-token-0123456789";
const project = `nova-notification-${process.pid}`;
let composeFile = "";

const fixtureFlows = [
  {
    id: "nova-compose-notification-test",
    type: "tab",
    label: "Compose notification test",
    disabled: false,
  },
  {
    id: "nova-compose-notification-inject",
    type: "inject",
    z: "nova-compose-notification-test",
    name: "Send one notification",
    props: [{ p: "payload" }],
    repeat: "",
    crontab: "",
    once: true,
    onceDelay: 0.2,
    topic: "",
    payload:
      '{"title":"Compose testmelding","detail":"Volledige NOVA-meldingsroute","severity":"info","category":"briefing"}',
    payloadType: "json",
    wires: [["nova-compose-notification-node"]],
  },
  {
    id: "nova-compose-notification-node",
    type: "nova-notify",
    z: "nova-compose-notification-test",
    name: "Send alert through the real NOVA API",
    wires: [[]],
  },
];

function run(command, args, options = {}) {
  const result = spawnSync(command, args, {
    cwd: root,
    encoding: "utf8",
    timeout: options.timeout ?? 30_000,
    env: process.env,
    ...options,
  });
  if (result.status !== 0)
    throw new Error(
      result.stderr?.trim() || result.stdout?.trim() || `${command} failed`,
    );
  return result.stdout.trim();
}

function compose(args, timeout = 30_000) {
  return run("docker", ["compose", "-p", project, "-f", composeFile, ...args], {
    timeout,
  });
}

try {
  chmodSync(temp, 0o777);
  const apiData = join(temp, "api-data");
  const nodeRedData = join(temp, "node-red-data");
  const helperData = join(temp, "helper-data");
  for (const dir of [apiData, nodeRedData, helperData]) {
    mkdirSync(dir, { mode: 0o777 });
    chmodSync(dir, 0o777);
  }
  writeFileSync(
    join(nodeRedData, "flows.json"),
    JSON.stringify(fixtureFlows, null, 2),
  );
  const helperServer = join(temp, "helper-mock.mjs");
  writeFileSync(
    helperServer,
    `import fs from "node:fs"; import http from "node:http";
const server = http.createServer((req,res) => {
  if (req.method === "GET" && req.url === "/health") { res.writeHead(200).end("ok"); return; }
  if (req.method !== "POST" || req.url !== "/v1/helper/notify" || req.headers.authorization !== "Bearer ${helperToken}") { res.writeHead(401).end(); return; }
  let body = ""; req.setEncoding("utf8"); req.on("data", chunk => body += chunk); req.on("end", () => { fs.writeFileSync("/data/last-notification.json", body); res.writeHead(200,{"content-type":"application/json"}).end(JSON.stringify({ok:true})); });
}); server.listen(8081,"0.0.0.0");`,
  );
  composeFile = join(temp, "compose.json");
  const config = {
    services: {
      nova: {
        image: process.env.NOVA_COMPOSE_TEST_NODE_IMAGE || "node:22-alpine",
        working_dir: "/workspace",
        command: ["node", "apps/api/dist/main.js"],
        volumes: [`${root}:/workspace:ro`, `${apiData}:/data`],
        environment: {
          PORT: "3000",
          NOVA_DATA_DIR: "/data",
          NOVA_BACKUP_DIR: "/backups",
          NODE_RED_URL: "http://node-red:1880",
          NODE_RED_EVENT_TOKEN: token,
          WINDOWS_AGENT_URL: "http://windows-mock:8081",
          WINDOWS_AGENT_TOKEN: helperToken,
          NOVA_CHECK_TARGETS: "self=tcp://localhost:3000",
          MQTT_URL: "mqtt://127.0.0.1:1883",
          FREE_ONLY: "true",
        },
        ports: ["127.0.0.1::3000"],
        healthcheck: {
          test: [
            "CMD",
            "node",
            "-e",
            "fetch('http://127.0.0.1:3000/api/nova/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ],
          interval: "2s",
          timeout: "2s",
          retries: 30,
        },
        networks: ["test"],
      },
      "windows-mock": {
        image: process.env.NOVA_COMPOSE_TEST_NODE_IMAGE || "node:22-alpine",
        command: ["node", "/mock/helper-mock.mjs"],
        volumes: [
          `${helperServer}:/mock/helper-mock.mjs:ro`,
          `${helperData}:/data`,
        ],
        healthcheck: {
          test: [
            "CMD",
            "node",
            "-e",
            "fetch('http://127.0.0.1:8081/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ],
          interval: "2s",
          timeout: "2s",
          retries: 15,
        },
        networks: ["test"],
      },
      "node-red": {
        image: process.env.NOVA_NODE_RED_TEST_IMAGE || "nodered/node-red:4.1",
        entrypoint: ["/bin/sh", "/opt/nova/nodered-seed/seed-entrypoint.sh"],
        environment: {
          NODE_RED_EVENT_TOKEN: token,
          NOVA_API_URL: "http://nova:3000",
        },
        volumes: [
          `${nodeRedData}:/data`,
          `${join(root, "deploy/nodered")}:/opt/nova/nodered-seed:ro`,
        ],
        ports: ["127.0.0.1::1880"],
        depends_on: { nova: { condition: "service_healthy" } },
        healthcheck: {
          test: [
            "CMD",
            "node",
            "-e",
            "fetch('http://127.0.0.1:1880/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))",
          ],
          interval: "2s",
          timeout: "2s",
          retries: 30,
          start_period: "10s",
        },
        networks: ["test"],
      },
    },
    networks: { test: {} },
  };
  writeFileSync(composeFile, JSON.stringify(config, null, 2));
  const build = run("npm", ["run", "build", "-w", "@nova/api"], {
    timeout: 180_000,
  });
  if (build) console.log(build);
  compose(["up", "--detach", "--wait"], 180_000);

  const apiBinding = compose(["port", "nova", "3000"]);
  const apiPort = Number(apiBinding.split(":").at(-1));
  const api = `http://127.0.0.1:${apiPort}`;
  const deadline = Date.now() + 45_000;
  let delivered = null;
  while (Date.now() < deadline) {
    try {
      const alertsResponse = await fetch(`${api}/api/alerts`, {
        signal: AbortSignal.timeout(2000),
      });
      const alerts = await alertsResponse.json();
      if (
        alerts.events?.some((event) => event.title === "Compose testmelding")
      ) {
        delivered = alerts.events.find(
          (event) => event.title === "Compose testmelding",
        );
        break;
      }
    } catch {
      // Wait for the one-shot Node-RED inject and the API feed update.
    }
    await delay(250);
  }
  assert.ok(delivered, "NOVA did not record the Node-RED alert in its feed");
  assert.equal(delivered.key, "briefing");
  assert.equal(delivered.speakAllowed, true);
  const notifyPath = join(helperData, "last-notification.json");
  const notifyDeadline = Date.now() + 10_000;
  while (!existsSync(notifyPath) && Date.now() < notifyDeadline)
    await delay(100);
  assert.ok(existsSync(notifyPath), "NOVA did not dispatch helper speech");
  const dispatch = JSON.parse(readFileSync(notifyPath, "utf8"));
  assert.equal(dispatch.event?.title, "Compose testmelding");
  assert.equal(dispatch.event?.detail, "Volledige NOVA-meldingsroute");
  assert.equal(dispatch.event?.kind, "alert");
  console.log(
    "Compose test passed: real Node-RED flow → real NOVA API → helper speech dispatch.",
  );
} finally {
  try {
    compose(["down", "--volumes", "--remove-orphans"], 60_000);
  } catch (error) {
    console.error(`Compose cleanup warning: ${error.message}`);
  }
  try {
    // All writers have stopped. Expose only our private fixture tree, never the repo.
    run("docker", [
      "run",
      "--rm",
      "--pull=never",
      "--network=none",
      "--user=0:0",
      "--mount",
      `type=bind,source=${temp},target=/data`,
      "--entrypoint=chown",
      process.env.NOVA_NODE_RED_TEST_IMAGE || "nodered/node-red:4.1",
      "-hR",
      `${process.getuid()}:${process.getgid()}`,
      "/data",
    ]);
  } catch (error) {
    console.error(
      `Compose fixture ownership cleanup warning: ${error.message}`,
    );
  }
  rmSync(temp, { recursive: true, force: true });
}

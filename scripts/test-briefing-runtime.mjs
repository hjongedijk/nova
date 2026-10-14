import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
  chmodSync,
  chownSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";

// Isolated real Node-RED + local fake API: no production mounts, ports or inference.
const image = process.env.NOVA_NODE_RED_TEST_IMAGE || "nodered/node-red:4.1";
const seed = resolve("deploy/nodered");
const fixture = mkdtempSync(join(tmpdir(), "nova-briefing-runtime-"));
const data = join(fixture, "data");
// Root hosts use the image's ordinary UID. Nonroot CI retains its host UID so
// private fixture files remain writable/readable without privileged chown.
const hostUid = process.getuid();
const runtimeUid = hostUid === 0 ? 1000 : hostUid;
const runtimeGid = hostUid === 0 ? 1000 : process.getgid();
function own(file) {
  if (hostUid === 0) chownSync(file, runtimeUid, runtimeGid);
}
const token = randomBytes(32).toString("hex");
const name = `nova-briefing-runtime-${randomBytes(6).toString("hex")}`;
const ids = ["runtime-scheduled-briefing", "runtime-event-briefing"];
const time = new Date().toISOString().slice(11, 16);
function docker(args, timeout = 30000) {
  const result = spawnSync("docker", args, {
    encoding: "utf8",
    timeout,
    maxBuffer: 1024 * 1024,
  });
  assert.equal(
    result.status,
    0,
    result.stderr?.trim() || `docker ${args[0]} failed`,
  );
  return (
    args[0] === "logs" ? result.stdout + result.stderr : result.stdout
  ).trim();
}
function readStats() {
  try {
    return JSON.parse(readFileSync(join(data, "fake-api-state.json"), "utf8"));
  } catch {
    return null;
  }
}
function jobs() {
  return ids.flatMap((id) => {
    const file = join(
      data,
      ".nova-workflows",
      `${createHash("sha256").update(id).digest("hex")}.json`,
    );
    try {
      return JSON.parse(readFileSync(file, "utf8")).jobs;
    } catch {
      return [];
    }
  });
}
async function until(test, label, timeout = 100000) {
  const end = Date.now() + timeout;
  while (Date.now() < end) {
    if (test()) return;
    assert.equal(
      docker(["inspect", "--format", "{{.State.Running}}", name]),
      "true",
      "fixture container stopped",
    );
    await delay(500);
  }
  throw new Error(`Timed out: ${label}`);
}
try {
  docker(["image", "inspect", image]); // Fail if absent; never pull.
  mkdirSync(data);
  own(fixture);
  chmodSync(fixture, 0o700);
  own(data);
  mkdirSync(join(data, "node_modules"));
  symlinkSync(
    "/opt/nova/nodered-seed/node-red-contrib-nova",
    join(data, "node_modules/node-red-contrib-nova"),
  );
  own(join(data, "node_modules"));
  const flows = [
    { id: "runtime-tab", type: "tab", label: "Private restart fixture" },
    {
      id: ids[0],
      type: "nova-briefing",
      z: "runtime-tab",
      kind: "morning_briefing",
      time,
      timezone: "UTC",
      wires: [[]],
    },
    {
      id: ids[1],
      type: "nova-briefing",
      z: "runtime-tab",
      kind: "evening_review",
      time: "",
      timezone: "UTC",
      wires: [[]],
    },
    {
      id: "runtime-event-inject",
      type: "inject",
      z: "runtime-tab",
      once: true,
      onceDelay: 0.3,
      repeat: "",
      crontab: "",
      props: [{ p: "novaEventId", v: "runtime-stable-event", vt: "str" }],
      wires: [[ids[1]]],
    },
  ];
  writeFileSync(join(data, "flows.json"), JSON.stringify(flows), {
    mode: 0o600,
  });
  own(join(data, "flows.json"));
  writeFileSync(
    join(fixture, "api.cjs"),
    `
const http = require('node:http');
const fs = require('node:fs');
const file = '/data/fake-api-state.json';
let state;
try { state=JSON.parse(fs.readFileSync(file,'utf8')); } catch { state={ asks:0, attempts:{}, eventRequests:0, accepted:{}, lostAck:false }; }
function save(){ fs.writeFileSync(file,JSON.stringify(state),{mode:0o600}); }
http.createServer(async(req,res)=>{
 if(req.headers.authorization!=='Bearer '+process.env.NODE_RED_EVENT_TOKEN){res.writeHead(401).end(); return;}
 let bytes=0,chunks=[];
 for await(const chunk of req){bytes+=chunk.length;if(bytes>20000){res.writeHead(413).end();return;}chunks.push(chunk);}
 const body=JSON.parse(Buffer.concat(chunks).toString());
 res.setHeader('content-type','application/json');
 if(req.url==='/api/proactive/ask'){
  const kind=body.message.includes('avondoverzicht')?'evening':'morning';
  state.asks++;state.attempts[kind]=(state.attempts[kind]||0)+1;save();
  if(state.attempts[kind]===1){res.writeHead(503).end('{"error":"temporary fixture outage"}');return;}
  res.end(JSON.stringify({reply:'Synthetische '+kind+' briefing.'}));return;
 }
 if(req.url==='/api/integrations/node-red/events'){
  if(!/^nova-workflow:[a-f0-9]{64}$/.test(body.deliveryId)||body.category!=='briefing'){res.writeHead(400).end();return;}
  state.eventRequests++;state.accepted[body.deliveryId]||=body;save();
  if(!state.lostAck){state.lostAck=true;save();res.destroy();return;}
  res.writeHead(202).end('{"accepted":true}');return;
 }
 res.writeHead(404).end();
}).listen(18765,'127.0.0.1');
`,
  );
  docker([
    "run",
    "--detach",
    "--pull",
    "never",
    "--name",
    name,
    "--user",
    `${runtimeUid}:${runtimeGid}`,
    "--network",
    "none",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--pids-limit",
    "96",
    "--memory",
    "384m",
    "--cpus",
    "1",
    "--env",
    "TZ=UTC",
    "--env",
    "NOVA_API_URL=http://127.0.0.1:18765",
    "--env",
    `NODE_RED_EVENT_TOKEN=${token}`,
    "--mount",
    `type=bind,source=${data},target=/data`,
    "--mount",
    `type=bind,source=${seed},target=/opt/nova/nodered-seed,readonly`,
    "--mount",
    `type=bind,source=${fixture},target=/fixture,readonly`,
    "--entrypoint",
    "/bin/sh",
    image,
    "-c",
    "node /fixture/api.cjs & exec /bin/sh /opt/nova/nodered-seed/seed-entrypoint.sh",
  ]);
  await until(
    () =>
      readStats()?.asks === 2 &&
      jobs().length === 2 &&
      jobs().every((job) => job.status === "pending" && job.attempts === 1),
    "initial automatic scheduled/event temporary failures",
    25000,
  );
  const pendingIds = jobs()
    .map((job) => job.id)
    .sort();
  docker(["restart", "--time", "5", name]);
  await until(
    () =>
      readStats()?.asks === 4 &&
      Object.keys(readStats().accepted).length === 2 &&
      jobs().some((job) => job.status === "reply"),
    "recovered replies and simulated lost acceptance acknowledgement",
  );
  docker(["restart", "--time", "5", name]);
  await until(
    () =>
      jobs().length === 2 && jobs().every((job) => job.status === "complete"),
    "saved reply delivery after second restart",
  );
  assert.deepEqual(
    jobs()
      .map((job) => job.id)
      .sort(),
    pendingIds,
  );
  assert.deepEqual(
    jobs()
      .map((job) => job.source)
      .sort(),
    ["event", "schedule"],
  );
  const completed = readStats();
  assert.equal(completed.asks, 4, "delivery retry must reuse saved reply");
  assert.equal(
    completed.eventRequests,
    3,
    "lost acknowledgement should retry one stable acceptance ID",
  );
  assert.equal(Object.keys(completed.accepted).length, 2);
  docker(["restart", "--time", "5", name]);
  await until(
    () => {
      try {
        return (
          docker([
            "exec",
            name,
            "node",
            "-e",
            "fetch('http://127.0.0.1:1880/flows').then(r=>r.json()).then(f=>{if(f.filter(n=>n.type==='nova-briefing').length!==2)process.exit(1)}).catch(()=>process.exit(1))",
          ]) === ""
        );
      } catch {
        return false;
      }
    },
    "actual Node-RED Admin API registration",
    20000,
  );
  await delay(1500); // Includes the automatic event re-injection after startup.
  assert.deepEqual(
    readStats(),
    completed,
    "completed workflows must not replay after restart",
  );
  const logs = docker(["logs", name]);
  assert.doesNotMatch(
    logs,
    /unknown node type|missing node types|Error loading|UnhandledPromiseRejection|uncaught exception/i,
  );
  console.log(
    "Briefing runtime: scheduled + event recovery, 3 restarts, lost-ack dedupe, saved-reply reuse PASS.",
  );
} finally {
  spawnSync("docker", ["rm", "--force", name], {
    encoding: "utf8",
    timeout: 15000,
  });
  rmSync(fixture, { recursive: true, force: true });
}

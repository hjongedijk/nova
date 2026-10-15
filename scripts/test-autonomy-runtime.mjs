// Three independent processes prove durable autonomy: a scheduled workflow that runs after a restart,
// an event-triggered workflow that pauses at a risky step, and approval resuming it in a later process.
// Uses the built API (npm -w apps/api run build): real AutonomyService/Store, JarvisStateStore,
// PlanningService and AlertsFeed; only the tool registry is a stub with one real read tool.
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = fs.mkdtempSync(
  path.join(os.tmpdir(), "nova-autonomy-runtime-"),
);
const url = (file) => pathToFileURL(path.resolve("apps/api/dist", file)).href;
const script = `
import path from 'node:path';
import fs from 'node:fs';
import { JarvisStateStore } from ${JSON.stringify(url("planning/jarvis-state.store.js"))};
import { PlanningService } from ${JSON.stringify(url("planning/planning.service.js"))};
import { AlertsFeed } from ${JSON.stringify(url("dashboard/alerts-feed.service.js"))};
import { AutonomyService } from ${JSON.stringify(url("planning/autonomy/autonomy.service.js"))};
import { AutonomyStore } from ${JSON.stringify(url("planning/autonomy/autonomy.store.js"))};
const dir = process.env.NOVA_AUTONOMY_TEST_DIR;
const phase = process.env.NOVA_AUTONOMY_TEST_PHASE;
const config = { dataFile: (n) => path.join(dir, n) };
const sensor = path.join(dir, 'sensor.txt');
const effects = path.join(dir, 'effects.log');
const tools = {
  list: () => [
    { name: 'sensor_read', risk: 'READ_ONLY', enabled: true },
    { name: 'pc_notify', risk: 'CONFIRM', enabled: true },
  ],
  async execute(name, args, session, approved, always, options) {
    if (name === 'sensor_read') return { ok: true, result: fs.readFileSync(sensor, 'utf8').trim() };
    if (name === 'pc_notify') {
      if (options.readOnlyOnly || !approved) return { ok: false, error: 'blocked' };
      fs.appendFileSync(effects, 'ran ' + JSON.stringify(args) + '\\n');
      return { ok: true, result: 'melding getoond' };
    }
    return { ok: false, error: 'Unknown tool' };
  },
};
const store = new JarvisStateStore(config, { publish() {} });
const planning = new PlanningService(store);
const feed = new AlertsFeed(planning, { configured: false }, { maySpeak: () => false, onSpeechAvailable: () => () => {} }, undefined, undefined, config);
feed.onModuleInit();
const svc = new AutonomyService(new AutonomyStore(config), tools, { record() {} }, store);
svc.recover();
const out = {};
if (phase === 'create') {
  fs.writeFileSync(sensor, 'temp=21');
  svc.create({ title: 'Ochtendmeting', delaySeconds: 2, steps: [{ tool: 'sensor_read' }] });
  svc.create({ title: 'Deur-alarm', event: 'door.open', notifyOnDone: false, steps: [{ tool: 'sensor_read' }, { tool: 'pc_notify', args: { text: 'deur open' } }] });
}
if (phase === 'restart') {
  await svc.tick(); await svc.tick();
  out.fired = svc.fireEvent('door.open', 'evt-1');
  out.again = svc.fireEvent('door.open', 'evt-1');
  for (let i = 0; i < 4; i++) await svc.tick();
}
if (phase === 'approve') {
  out.approved = svc.approve(svc.list().find((t) => t.title === 'Deur-alarm').id);
  for (let i = 0; i < 3; i++) await svc.tick();
}
out.tasks = svc.list().map((t) => ({ title: t.title, status: t.status, runs: t.runs, last: t.lastRun?.summary, waiting: Object.entries(t.run?.steps ?? {}).filter(([, s]) => s.status === 'waiting_approval').map(([k]) => k) }));
out.feed = feed.recent().events.map((e) => e.title);
out.effects = fs.existsSync(effects) ? fs.readFileSync(effects, 'utf8').trim().split('\\n').length : 0;
console.log('PROOF ' + JSON.stringify(out));
feed.onModuleDestroy(); planning.onModuleDestroy();
`;
function run(phase) {
  const child = spawnSync(
    process.execPath,
    ["--input-type=module", "-e", script],
    {
      env: {
        ...process.env,
        NOVA_AUTONOMY_TEST_DIR: directory,
        NOVA_AUTONOMY_TEST_PHASE: phase,
      },
      encoding: "utf8",
      timeout: 20_000,
    },
  );
  assert.equal(child.status, 0, `phase ${phase} failed: ${child.stderr}`);
  const line = child.stdout.split("\n").find((l) => l.startsWith("PROOF "));
  assert(line, `missing proof: ${phase}`);
  return JSON.parse(line.slice(6));
}
try {
  const created = run("create");
  assert.deepEqual(
    created.tasks.map((t) => t.status),
    ["scheduled", "scheduled"],
  );
  assert.equal(created.effects, 0);
  await new Promise((r) => setTimeout(r, 2500)); // the first process is gone; the due time passes
  const restarted = run("restart");
  console.log(JSON.stringify(restarted));
  const byTitle = Object.fromEntries(restarted.tasks.map((t) => [t.title, t]));
  assert.equal(byTitle["Ochtendmeting"].status, "completed");
  assert.equal(byTitle["Ochtendmeting"].last, "temp=21");
  assert.equal(restarted.fired.started, 1);
  assert.equal(restarted.again.started, 0, "same event id is idempotent");
  assert.deepEqual(byTitle["Deur-alarm"].waiting, ["s2"]);
  assert.equal(restarted.effects, 0, "risky step must not run before approval");
  assert(restarted.feed.includes("Goedkeuring nodig: Deur-alarm"));
  assert(restarted.feed.includes("Taak klaar: Ochtendmeting"));
  const approved = run("approve");
  console.log(JSON.stringify(approved));
  assert.deepEqual(approved.approved, ["s2"]);
  assert.equal(approved.effects, 1, "approved step runs exactly once");
  assert.equal(
    Object.fromEntries(approved.tasks.map((t) => [t.title, t]))["Deur-alarm"]
      .runs,
    1,
  );
  const file = path.join(directory, "autonomy-tasks.json");
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  console.log(
    "Autonomy runtime PASS: scheduled run after restart, event trigger with idempotent id, approval pause and resume across processes.",
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

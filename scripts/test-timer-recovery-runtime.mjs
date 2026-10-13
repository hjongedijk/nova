import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-timer-runtime-"));
const moduleUrl = (file) =>
  pathToFileURL(path.resolve("apps/api/dist", file)).href;
const script = `
import path from 'node:path';
import { JarvisStateStore } from ${JSON.stringify(moduleUrl("planning/jarvis-state.store.js"))};
import { PlanningService } from ${JSON.stringify(moduleUrl("planning/planning.service.js"))};
import { AlertsFeed } from ${JSON.stringify(moduleUrl("dashboard/alerts-feed.service.js"))};
const config={dataFile:name=>path.join(process.env.NOVA_TIMER_TEST_DIR,name)};
const store=new JarvisStateStore(config,{publish(){}});
const planning=new PlanningService(store);
let delivered=0;
const feed=new AlertsFeed(planning,{configured:true,async notifyHelper(){delivered++;return {ok:true};}},{maySpeak:()=>false,onSpeechAvailable:()=>()=>{}},undefined,undefined,config);
const phase=process.env.NOVA_TIMER_TEST_PHASE;
if(phase!=='queue')feed.onModuleInit();
if(phase==='queue')planning.setTimer({seconds:1,label:'runtime restart proof'});
planning.onModuleInit();
setTimeout(()=>{
 console.log('PROOF '+JSON.stringify({active:store.data.timers.length,pending:store.data.timerOutbox.length,visible:feed.recent().events.length,delivered}));
 planning.onModuleDestroy();feed.onModuleDestroy();
},1500);
`;
try {
  const results = [];
  for (const phase of ["queue", "recover", "restore"]) {
    const child = spawnSync(
      process.execPath,
      ["--input-type=module", "-e", script],
      {
        env: {
          ...process.env,
          NOVA_TIMER_TEST_DIR: directory,
          NOVA_TIMER_TEST_PHASE: phase,
        },
        encoding: "utf8",
        timeout: 10_000,
      },
    );
    assert.equal(
      child.status,
      0,
      `Timer runtime phase ${phase} failed: ${child.stderr}`,
    );
    const proof = child.stdout
      .split("\n")
      .find((line) => line.startsWith("PROOF "));
    assert(proof, `Missing runtime proof: ${phase}`);
    results.push(JSON.parse(proof.slice(6)));
  }
  assert.deepEqual(results, [
    { active: 0, pending: 1, visible: 0, delivered: 0 },
    { active: 0, pending: 0, visible: 1, delivered: 1 },
    { active: 0, pending: 0, visible: 1, delivered: 0 },
  ]);
  console.log(
    "Three independent processes PASS: background expiry queued, restart recovery accepted once, subsequent restart restored silently.",
  );
} finally {
  fs.rmSync(directory, { recursive: true, force: true });
}

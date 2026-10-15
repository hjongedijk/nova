"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createHash } = require("node:crypto");
const { EventEmitter } = require("node:events");
const { BriefingState } = require("../briefing-state");
const register = require("../briefing");

function fixture(t, fetch) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-briefing-node-"));
  const saved = {
    fetch: global.fetch,
    setInterval: global.setInterval,
    clearInterval: global.clearInterval,
    token: process.env.NODE_RED_EVENT_TOKEN,
  };
  let poll;
  let cleared = false;
  global.fetch = fetch;
  global.setInterval = (callback, delay) => {
    assert.equal(delay, 30000);
    poll = callback;
    return { unref() {} };
  };
  global.clearInterval = () => {
    cleared = true;
  };
  process.env.NODE_RED_EVENT_TOKEN =
    "synthetic-event-token-12345678901234567890";
  let Node;
  register({
    settings: { userDir: dir },
    nodes: {
      registerType: (_name, constructor) => {
        Node = constructor;
      },
      createNode: (node) => {
        const emitter = new EventEmitter();
        node.id = "test-node";
        node.on = emitter.on.bind(emitter);
        node.emit = emitter.emit.bind(emitter);
        node.sent = [];
        node.statuses = [];
        node.send = (msg) => node.sent.push(msg);
        node.status = (status) => node.statuses.push(status);
      },
    },
  });
  let instance;
  const close = () =>
    instance
      ? new Promise((resolve) => instance.emit("close", false, resolve))
      : Promise.resolve();
  t.after(async () => {
    await close();
    global.fetch = saved.fetch;
    global.setInterval = saved.setInterval;
    global.clearInterval = saved.clearInterval;
    if (saved.token === undefined) delete process.env.NODE_RED_EVENT_TOKEN;
    else process.env.NODE_RED_EVENT_TOKEN = saved.token;
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return {
    file: path.join(
      dir,
      ".nova-workflows",
      `${createHash("sha256").update("test-node").digest("hex")}.json`,
    ),
    open: () => (instance = new Node({ kind: "morning_briefing", time: "" })),
    poll: () => poll(),
    close,
    cleared: () => cleared,
  };
}

const settle = () => new Promise((resolve) => setImmediate(resolve));

test("startup corruption stays untouched and polling resumes persisted work after repair", async (t) => {
  const calls = [];
  const f = fixture(t, async (url, options) => {
    calls.push({ url, body: JSON.parse(options.body) });
    return new Response(
      JSON.stringify(
        url.endsWith("/api/proactive/ask")
          ? { reply: "Synthetische herstelde briefing." }
          : { accepted: true },
      ),
      { headers: { "content-type": "application/json" } },
    );
  });
  const original = new BriefingState({
    file: f.file,
    nodeId: "test-node",
    kind: "morning_briefing",
    ask: async () => "unused",
    deliver: async () => {},
  });
  original.event("startup-recovery");
  await original.close();
  const valid = fs.readFileSync(f.file, "utf8");
  fs.writeFileSync(f.file, "{corrupt");
  const node = f.open();
  await f.poll();
  assert.equal(fs.readFileSync(f.file, "utf8"), "{corrupt");
  assert.equal(calls.length, 0);
  assert.equal(node.statuses.at(-1).fill, "red");
  fs.writeFileSync(f.file, valid);
  await f.poll();
  assert.equal(calls.length, 2);
  assert.equal(new URL(calls[0].url).pathname, "/api/proactive/ask");
  assert.equal(calls[0].body.modelRole, "summary");
  assert.match(calls[0].body.message, /ochtendbriefing/);
  assert.equal(
    new URL(calls[1].url).pathname,
    "/api/integrations/node-red/events",
  );
  assert.match(calls[1].body.deliveryId, /^nova-workflow:[a-f0-9]{64}$/);
  assert.equal(node.sent.length, 1);
  assert.equal(
    JSON.parse(fs.readFileSync(f.file, "utf8")).jobs[0].status,
    "complete",
  );
  await f.poll();
  assert.equal(calls.length, 2);
});

test("close aborts an in-flight request and prevents polling or input from restarting it", async (t) => {
  let calls = 0;
  let aborted = false;
  const f = fixture(t, (_url, options) => {
    calls++;
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => {
          aborted = true;
          reject(options.signal.reason);
        },
        { once: true },
      );
    });
  });
  const node = f.open();
  await settle();
  node.emit(
    "input",
    { novaEventId: "close-during-request" },
    undefined,
    (error) => {
      assert.equal(error, undefined);
    },
  );
  await settle();
  assert.equal(calls, 1);
  await f.close();
  assert.equal(aborted, true);
  assert.equal(f.cleared(), true);
  assert.equal(node.sent.length, 0);
  await f.poll();
  let inputError;
  node.emit("input", { novaEventId: "after-close" }, undefined, (error) => {
    inputError = error;
  });
  assert.ok(inputError);
  assert.equal(calls, 1);
  assert.equal(JSON.parse(fs.readFileSync(f.file, "utf8")).jobs.length, 1);
});

test("unavailable live information survives restart and retries before delivery", async (t) => {
  const realNow = Date.now;
  let now = realNow();
  Date.now = () => now;
  t.after(() => {
    Date.now = realNow;
  });
  let asks = 0,
    deliveries = 0;
  const f = fixture(t, async (url) => {
    if (url.endsWith("/api/proactive/ask")) {
      asks++;
      return new Response(
        JSON.stringify(
          asks === 1
            ? { error: "Current information is unavailable." }
            : { reply: "Synthetic recovered briefing." },
        ),
        {
          status: asks === 1 ? 503 : 200,
          headers: { "content-type": "application/json" },
        },
      );
    }
    deliveries++;
    return new Response(JSON.stringify({ accepted: true }), {
      headers: { "content-type": "application/json" },
    });
  });
  const seed = new BriefingState({
    file: f.file,
    nodeId: "test-node",
    kind: "morning_briefing",
    ask: async () => "unused",
    deliver: async () => {},
  });
  seed.event("unavailable-live-data");
  await seed.close();
  const node = f.open();
  await f.poll();
  assert.equal(asks, 1);
  assert.equal(deliveries, 0);
  assert.equal(node.sent.length, 0);
  let job = JSON.parse(fs.readFileSync(f.file, "utf8")).jobs[0];
  assert.equal(job.status, "pending");
  assert.equal(job.attempts, 1);
  assert.equal(job.reply, undefined);
  await f.close();
  now += 30001;
  const resumed = f.open();
  await f.poll();
  assert.equal(asks, 2);
  assert.equal(deliveries, 1);
  assert.equal(resumed.sent.length, 1);
  job = JSON.parse(fs.readFileSync(f.file, "utf8")).jobs[0];
  assert.equal(job.status, "complete");
  await f.poll();
  assert.equal(asks, 2);
  assert.equal(deliveries, 1);
});

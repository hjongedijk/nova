"use strict";
const assert = require("node:assert/strict");
const { test } = require("node:test");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { BriefingState } = require("../briefing-state");

function fixture(t, overrides = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-briefing-test-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  let clock = Date.parse("2026-10-14T05:30:00Z");
  const state = {
    asks: 0,
    deliveries: [],
    options: {
      file: path.join(dir, "private", "state.json"),
      nodeId: "briefing-test",
      kind: "morning_briefing",
      time: "07:30",
      timezone: "Europe/Amsterdam",
      now: () => clock,
      ask: async () => {
        state.asks++;
        return "Een synthetische briefing voor de proef.";
      },
      deliver: async (job) => {
        state.deliveries.push(job);
      },
      ...overrides,
    },
    advance: (ms) => {
      clock += ms;
    },
  };
  state.open = () => {
    const engine = new BriefingState(state.options);
    t.after(() => engine.close());
    return engine;
  };
  return state;
}

test("scheduled job runs without input, survives restart and stays deduplicated", async (t) => {
  const f = fixture(t);
  let engine = f.open();
  await engine.tick();
  assert.equal(f.asks, 1);
  assert.equal(f.deliveries.length, 1);
  assert.equal(fs.statSync(f.options.file).mode & 0o777, 0o600);
  await engine.close();
  engine = f.open();
  await engine.tick();
  assert.equal(f.asks, 1);
  assert.equal(f.deliveries.length, 1);
  f.advance(86400000);
  await engine.tick();
  assert.equal(f.asks, 2);
});

test("temporary model failure persists backoff and recovers after owner restart", async (t) => {
  const f = fixture(t);
  let calls = 0;
  f.options.ask = async () => {
    if (++calls === 1) throw new Error("synthetic unavailable");
    return "De herstelde briefing.";
  };
  let engine = f.open();
  await engine.tick();
  assert.equal(calls, 1);
  assert.equal(f.deliveries.length, 0);
  await engine.close();
  engine = f.open();
  await engine.tick();
  assert.equal(calls, 1);
  f.advance(30000);
  await engine.tick();
  assert.equal(calls, 2);
  assert.equal(f.deliveries.length, 1);
  await engine.close();
  engine = f.open();
  await engine.tick();
  assert.equal(calls, 2);
});

test("lost delivery acknowledgement reuses persisted reply and identical ID", async (t) => {
  const f = fixture(t, { time: "" });
  const accepted = new Set();
  let attempts = 0;
  f.options.deliver = async (job) => {
    accepted.add(job.id);
    if (++attempts === 1) throw new Error("ack lost");
  };
  let engine = f.open();
  engine.event("sensor-arrival-001");
  await engine.tick();
  assert.equal(engine.jobs[0].status, "reply");
  await engine.close();
  engine = f.open();
  f.advance(30000);
  await engine.tick();
  assert.equal(f.asks, 1);
  assert.equal(attempts, 2);
  assert.equal(accepted.size, 1);
  assert.equal(engine.jobs[0].status, "complete");
  assert.equal(engine.event("sensor-arrival-001"), false);
});

test("missed schedule catches up within four hours, skips older slots and handles midnight", async (t) => {
  const f = fixture(t, { time: "23:30" });
  let engine = f.open();
  await engine.tick();
  assert.equal(f.asks, 0);
  await engine.close();
  f.options.now = () => Date.parse("2026-10-14T22:15:00Z");
  engine = f.open();
  await engine.tick();
  assert.equal(f.asks, 1);
  f.options.now = () => Date.parse("2026-10-15T03:00:00Z");
  await engine.close();
  engine = f.open();
  await engine.tick();
  assert.equal(f.asks, 1);
});

test("repeated autumn DST clock slot executes only once", async (t) => {
  const f = fixture(t, {
    time: "02:30",
    now: () => Date.parse("2026-10-25T00:30:00Z"),
  });
  let engine = f.open();
  await engine.tick();
  await engine.close();
  f.options.now = () => Date.parse("2026-10-25T01:30:00Z");
  engine = f.open();
  await engine.tick();
  assert.equal(f.asks, 1);
});

test("same-process duplicate owner rejected; concurrent ticks share one call", async (t) => {
  const f = fixture(t);
  let release;
  f.options.ask = () =>
    new Promise((resolve) => {
      release = resolve;
    });
  const engine = f.open();
  assert.throws(() => new BriefingState(f.options), /owner/);
  const first = engine.tick();
  const second = engine.tick();
  assert.equal(first, second);
  release("Een gedeelde proef.");
  await Promise.all([first, second]);
  assert.equal(f.deliveries.length, 1);
});

test("six model failures terminate bounded retries and expired jobs never call models", async (t) => {
  const f = fixture(t, { time: "" });
  let calls = 0;
  f.options.ask = async () => {
    calls++;
    throw new Error();
  };
  const engine = f.open();
  engine.event("bounded-001");
  for (let i = 0; i < 8; i++) {
    await engine.tick();
    f.advance(15 * 60000);
  }
  assert.equal(calls, 6);
  assert.equal(engine.jobs[0].status, "failed");
  engine.event("expired-001");
  f.advance(4 * 3600000 + 1);
  await engine.tick();
  assert.equal(calls, 6);
});

test("corrupt, non-private and symlinked state fails closed", async (t) => {
  const f = fixture(t);
  fs.mkdirSync(path.dirname(f.options.file));
  fs.writeFileSync(f.options.file, "{broken", { mode: 0o600 });
  assert.throws(() => f.open(), /state unavailable/);
  fs.writeFileSync(f.options.file, '{"version":1,"jobs":[]}');
  fs.chmodSync(f.options.file, 0o644);
  assert.throws(() => f.open(), /state unavailable/);
  fs.unlinkSync(f.options.file);
  const target = path.join(path.dirname(f.options.file), "target");
  fs.writeFileSync(target, '{"version":1,"jobs":[]}', { mode: 0o600 });
  fs.symlinkSync(target, f.options.file);
  assert.throws(() => f.open(), /state unavailable/);
  assert.equal(f.asks, 0);
});

test("storage failure prevents request and later restoration retries from durable state", async (t) => {
  const f = fixture(t);
  const engine = f.open();
  engine.event("storage-001");
  const parent = path.dirname(f.options.file);
  const moved = `${parent}-moved`;
  fs.renameSync(parent, moved);
  fs.writeFileSync(parent, "blocked");
  await assert.rejects(engine.tick());
  assert.equal(f.asks, 0);
  fs.unlinkSync(parent);
  fs.renameSync(moved, parent);
  await engine.tick();
  assert.equal(f.asks, 1);
  assert.equal(f.deliveries.length, 1);
});

test("config change cannot execute an old pending job under a new kind", async (t) => {
  const f = fixture(t, { time: "" });
  let engine = f.open();
  engine.event("pending-old");
  await engine.close();
  f.options.kind = "evening_review";
  engine = f.open();
  await engine.tick();
  assert.equal(f.asks, 0);
  assert.equal(engine.jobs[0].status, "failed");
  assert.throws(() => engine.event("../unsafe"), /stable/);
});

test("consecutive inputs after ambiguous directory fsync preserve both persisted events", async (t) => {
  const f = fixture(t, { time: "" });
  const engine = f.open();
  const original = fs.fsyncSync;
  let syncs = 0;
  fs.fsyncSync = (descriptor) => {
    if (++syncs === 2) throw new Error("directory sync failed");
    return original(descriptor);
  };
  try {
    assert.throws(() => engine.event("event-one"));
  } finally {
    fs.fsyncSync = original;
  }
  engine.event("event-two");
  assert.equal(
    JSON.parse(fs.readFileSync(f.options.file, "utf8")).jobs.length,
    2,
  );
  await engine.tick();
  await engine.tick();
  assert.equal(f.asks, 2);
  assert.equal(f.deliveries.length, 2);
});

test("oversized generated briefing is clearly marked shortened within the feed limit", async (t) => {
  const f = fixture(t, {
    ask: async () => "Een langere synthetische zin. ".repeat(20),
  });
  await f.open().tick();
  assert(f.deliveries[0].reply.length <= 240);
  assert.match(f.deliveries[0].reply, /… \(ingekort\)$/);
});

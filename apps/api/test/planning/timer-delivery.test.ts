import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { JarvisStateStore } from "../../src/planning/jarvis-state.store.js";
import { PlanningService } from "../../src/planning/planning.service.js";
import { AlertsFeed } from "../../src/dashboard/alerts-feed.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { MqttService } from "../../src/core/mqtt/mqtt.service.js";
import type { WindowsPcService } from "../../src/integrations/windows/windows-pc.service.js";
import type { SpeechPresenceService } from "../../src/dashboard/speech-presence.service.js";
import {
  dbStat,
  failStateWrites,
  seedState,
  stateExists,
} from "../helpers/nova-db.js";

let dir: string;
const running: Array<{ planning: PlanningService; feed: AlertsFeed }> = [];
const notifyHelper = vi.fn(async () => ({ ok: true }));
const publish = vi.fn();
function boot(startFeed = true, maySpeak = false) {
  const config = {
    dataFile: (name: string) => path.join(dir, name),
  } as NovaConfig;
  const store = new JarvisStateStore(config, {
    publish,
  } as unknown as MqttService);
  const planning = new PlanningService(store);
  const feed = new AlertsFeed(
    planning,
    { configured: true, notifyHelper } as unknown as WindowsPcService,
    {
      maySpeak: () => maySpeak,
      onSpeechAvailable: () => () => undefined,
    } as unknown as SpeechPresenceService,
    undefined,
    undefined,
    config,
  );
  if (startFeed) feed.onModuleInit();
  running.push({ planning, feed });
  return { store, planning, feed };
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-timer-delivery-"));
  notifyHelper.mockClear();
  publish.mockClear();
  vi.useFakeTimers();
});
afterEach(() => {
  for (const { planning, feed } of running.splice(0)) {
    planning.onModuleDestroy();
    feed.onModuleDestroy();
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe("durable timer feed delivery", () => {
  it("resumes queued expiry after a process restart before acceptance", async () => {
    const first = boot(false);
    first.planning.setTimer({ seconds: 2, label: "restart tea" });
    first.planning.onModuleInit();
    await vi.advanceTimersByTimeAsync(3000);
    expect(first.store.data.timers).toEqual([]);
    expect(first.store.data.timerOutbox).toHaveLength(1);
    expect(publish).not.toHaveBeenCalled();
    first.planning.onModuleDestroy();
    const restarted = boot();
    restarted.planning.onModuleInit();
    await vi.advanceTimersByTimeAsync(1000);
    expect(restarted.feed.recent().events).toMatchObject([
      { kind: "timer", label: "restart tea" },
    ]);
    expect(restarted.store.data.timerOutbox).toEqual([]);
    expect(publish).toHaveBeenCalledOnce();
    expect(notifyHelper).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(5000);
    expect(notifyHelper).toHaveBeenCalledOnce();
  });
  it("retries transient consumer failure without premature publishing", async () => {
    const { store, planning, feed } = boot();
    planning.setTimer({ seconds: 2, label: "temporary failure" });
    vi.spyOn(feed, "record").mockImplementationOnce(() => {
      throw new Error("private consumer error");
    });
    planning.onModuleInit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.data.timerOutbox).toHaveLength(1);
    expect(feed.recent().events).toEqual([]);
    expect(publish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.data.timerOutbox).toEqual([]);
    expect(feed.recent().events).toHaveLength(1);
    expect(notifyHelper).toHaveBeenCalledOnce();
  });
  it("does not acknowledge or notify before acceptance journal commit", async () => {
    const { store, planning, feed } = boot();
    planning.setTimer({ seconds: 2, label: "persist the notice" });
    const failure = failStateWrites(
      path.join(dir, "timer-feed.json"),
      "ENOSPC private-journal-path",
    );
    planning.onModuleInit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.data.timerOutbox).toHaveLength(1);
    expect(feed.recent().events).toEqual([]);
    expect(notifyHelper).not.toHaveBeenCalled();
    expect(publish).not.toHaveBeenCalled();
    failure.mockRestore();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.data.timerOutbox).toEqual([]);
    expect(feed.recent().events).toHaveLength(1);
    expect(dbStat(path.join(dir, "timer-feed.json")).mode & 0o777).toBe(0o600);
  });
  it("does not spend speech budget when timer acceptance cannot be saved", async () => {
    const { store, planning, feed } = boot(true, true);
    planning.setTimer({ seconds: 2, label: "recover speech budget" });
    const failure = failStateWrites(
      path.join(dir, "timer-feed.json"),
      "ENOSPC",
    );
    planning.onModuleInit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.data.timerOutbox).toHaveLength(1);
    expect(stateExists(path.join(dir, "spoken-alert-progress.json"))).toBe(
      false,
    );
    expect(notifyHelper).not.toHaveBeenCalled();
    failure.mockRestore();
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.data.timerOutbox).toEqual([]);
    expect(feed.recent().events[0]?.speakAllowed).toBe(true);
    expect(notifyHelper).toHaveBeenCalledOnce();
  });
  it("deduplicates across a crash before producer acknowledgement", async () => {
    const first = boot();
    first.planning.setTimer({ seconds: 2, label: "ack recovery" });
    const rename = fs.renameSync;
    let commits = 0;
    const failure = vi
      .spyOn(fs, "renameSync")
      .mockImplementation((source, destination) => {
        if (destination === first.store.file && ++commits === 2)
          throw new Error("ENOSPC private-ack-path");
        return rename(source, destination);
      });
    first.planning.onModuleInit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(first.feed.recent().events).toHaveLength(1);
    const original = first.feed.recent().events[0]!;
    expect(first.store.data.timerOutbox).toHaveLength(1);
    expect(notifyHelper).toHaveBeenCalledOnce();
    expect(publish).not.toHaveBeenCalled();
    first.planning.onModuleDestroy();
    first.feed.onModuleDestroy();
    failure.mockRestore();
    const restarted = boot();
    expect(restarted.feed.recent().events).toMatchObject([
      {
        seq: original.seq,
        label: original.label,
        at: original.at,
        speakAllowed: false,
        deliveryMode: "screen",
      },
    ]);
    restarted.planning.onModuleInit();
    await vi.advanceTimersByTimeAsync(5000);
    expect(restarted.store.data.timerOutbox).toEqual([]);
    expect(restarted.feed.recent().events).toHaveLength(1);
    expect(notifyHelper).toHaveBeenCalledOnce();
    expect(publish).toHaveBeenCalledOnce();
  });
  it("restores accepted history silently after acknowledgement and restart", async () => {
    const first = boot();
    first.planning.setTimer({ seconds: 2, label: "durable visible history" });
    first.planning.onModuleInit();
    await vi.advanceTimersByTimeAsync(3000);
    expect(first.store.data.timerOutbox).toEqual([]);
    first.planning.onModuleDestroy();
    first.feed.onModuleDestroy();
    const restarted = boot();
    expect(restarted.feed.recent().events).toMatchObject([
      { label: "durable visible history", speakAllowed: false },
    ]);
    expect(restarted.feed.claimSpeech(restarted.feed.recent().latest)).toBe(
      false,
    );
    expect(notifyHelper).toHaveBeenCalledOnce();
  });
  it("keeps pending timers on corrupt history and accepts after repair", async () => {
    seedState(
      path.join(dir, "timer-feed.json"),
      "invalid JSON private fixture",
    );
    const { planning, store, feed } = boot();
    planning.setTimer({ seconds: 2, label: "repair history" });
    planning.onModuleInit();
    await vi.advanceTimersByTimeAsync(2000);
    expect(store.data.timerOutbox).toHaveLength(1);
    expect(feed.recent().events).toEqual([]);
    seedState(path.join(dir, "timer-feed.json"), { version: 1, entries: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(store.data.timerOutbox).toEqual([]);
    expect(feed.recent().events).toHaveLength(1);
  });
  it("bounds retry rate and retains active timers when outbox is full", () => {
    const { planning, store, feed } = boot();
    const receive = vi.spyOn(feed, "record").mockImplementation(() => {
      throw new Error("offline");
    });
    const now = Date.now() + 3000;
    for (let batch = 0; batch < 6; batch++) {
      for (let timer = 0; timer < 20; timer++)
        planning.setTimer({ seconds: 2 });
      planning.fireDueTimers(now);
    }
    expect(store.data.timerOutbox).toHaveLength(100);
    expect(store.data.timers).toHaveLength(20);
    expect(receive).toHaveBeenCalledTimes(100);
    planning.fireDueTimers(now + 999);
    expect(receive).toHaveBeenCalledTimes(100);
    planning.fireDueTimers(now + 1000);
    expect(receive).toHaveBeenCalledTimes(200);
    planning.fireDueTimers(now + 2999);
    expect(receive).toHaveBeenCalledTimes(200);
    planning.fireDueTimers(now + 3000);
    expect(receive).toHaveBeenCalledTimes(300);
    expect(store.data.timers).toHaveLength(20);
  });
});

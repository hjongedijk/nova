import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { PlanningService } from "../../src/planning/planning.service.js";
import { AlertsFeed } from "../../src/dashboard/alerts-feed.service.js";
import { WorkflowFeedJournal } from "../../src/dashboard/workflow-feed-journal.js";
import { NodeRedEventsController } from "../../src/dashboard/node-red-events.controller.js";

let dir: string;
const token = "a".repeat(64);
const deliveryId = `nova-workflow:${"b".repeat(64)}`;
const notifyHelper = vi.fn(async () => ({ ok: true }));
const notify = vi.fn(async () => undefined);
const input = {
  title: "Ochtendbriefing",
  detail: "Je dag staat klaar.",
  category: "briefing" as const,
  deliveryId,
};
function boot() {
  const config = {
    nodeRedEventToken: token,
    dataFile: (name: string) => path.join(dir, name),
  } as NovaConfig;
  const feed = new AlertsFeed(
    { onEvent: () => () => undefined } as unknown as PlanningService,
    { configured: true, notifyHelper } as never,
    { maySpeak: () => true } as never,
    { notify } as never,
    undefined,
    config,
  );
  const controller = new NodeRedEventsController(
    config,
    feed,
    {} as never,
    { record: vi.fn() } as never,
  );
  return { feed, controller };
}
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "nova-workflow-feed-"));
  notifyHelper.mockClear();
  notify.mockClear();
});
afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(dir, { recursive: true, force: true });
});
describe("durable workflow alert acceptance", () => {
  it("acknowledges retries across restart without repeating delivery or speech", () => {
    const first = boot();
    const original = first.feed.recordNodeRedAlert(input)!;
    expect(original.speakAllowed).toBe(true);
    expect(first.feed.recordNodeRedAlert(input)?.seq).toBe(original.seq);
    expect(notifyHelper).toHaveBeenCalledOnce();
    const restarted = boot();
    expect(
      restarted.controller.receive(`Bearer ${token}`, {
        type: "alert",
        ...input,
      }),
    ).toEqual({ accepted: true });
    expect(restarted.feed.recent().events).toEqual([
      { ...original, speakAllowed: false, deliveryMode: "screen" },
    ]);
    expect(restarted.feed.claimSpeech(original.seq)).toBe(false);
    expect(notifyHelper).toHaveBeenCalledOnce();
    expect(fs.statSync(path.join(dir, "workflow-feed.json")).mode & 0o777).toBe(
      0o600,
    );
  });
  it("never sends duplicate critical pushes", () => {
    boot().feed.recordNodeRedAlert({ ...input, severity: "critical" });
    boot().feed.recordNodeRedAlert({ ...input, severity: "critical" });
    expect(notify).toHaveBeenCalledOnce();
  });
  it("rejects failed persistence without notification or spent speech budget, then recovers", () => {
    const { controller, feed } = boot();
    const rename = fs.renameSync;
    const failure = vi
      .spyOn(fs, "renameSync")
      .mockImplementation((source, destination) => {
        if (String(destination).endsWith("workflow-feed.json"))
          throw new Error("ENOSPC private diagnostics");
        return rename(source, destination);
      });
    expect(() =>
      controller.receive(`Bearer ${token}`, { type: "alert", ...input }),
    ).toThrow("Node-RED alert acceptance unavailable");
    try {
      controller.receive(`Bearer ${token}`, { type: "alert", ...input });
    } catch (error) {
      expect((error as { getStatus(): number }).getStatus()).toBe(503);
    }
    expect(feed.recent().events).toEqual([]);
    expect(notifyHelper).not.toHaveBeenCalled();
    expect(fs.existsSync(path.join(dir, "spoken-alert-progress.json"))).toBe(
      false,
    );
    failure.mockRestore();
    expect(
      controller.receive(`Bearer ${token}`, { type: "alert", ...input }),
    ).toEqual({ accepted: true });
    expect(feed.recent().events[0]?.speakAllowed).toBe(true);
    expect(notifyHelper).toHaveBeenCalledOnce();
  });
  it("settles a renamed journal after sync failure without reissuing native delivery", () => {
    const { controller, feed } = boot();
    const sync = fs.fsyncSync;
    const failure = vi.spyOn(fs, "fsyncSync").mockImplementation((fd) => {
      if (fs.fstatSync(fd).isDirectory())
        throw new Error("temporary directory sync failure");
      return sync(fd);
    });
    expect(() =>
      controller.receive(`Bearer ${token}`, { type: "alert", ...input }),
    ).toThrow("Node-RED alert acceptance unavailable");
    expect(notifyHelper).not.toHaveBeenCalled();
    expect(feed.recent().events).toEqual([]);
    failure.mockRestore();
    expect(
      controller.receive(`Bearer ${token}`, { type: "alert", ...input }),
    ).toEqual({ accepted: true });
    expect(feed.recent().events).toHaveLength(1);
    expect(feed.recent().events[0]?.speakAllowed).toBe(false);
    expect(notifyHelper).not.toHaveBeenCalled();
  });
  it("fails closed on corrupt history while ordinary notifications remain available", () => {
    fs.writeFileSync(path.join(dir, "workflow-feed.json"), "corrupt");
    const { controller, feed } = boot();
    expect(() =>
      controller.receive(`Bearer ${token}`, { type: "alert", ...input }),
    ).toThrow("Node-RED alert acceptance unavailable");
    expect(notifyHelper).not.toHaveBeenCalled();
    expect(feed.recordNodeRedAlert({ title: "Gewone melding" })).not.toBeNull();
  });
  it.each([
    null,
    4,
    "",
    "nova-workflow:abc",
    `nova-workflow:${"A".repeat(64)}`,
  ])("rejects malformed workflow id %j", (value) => {
    const { controller } = boot();
    expect(() =>
      controller.receive(`Bearer ${token}`, {
        type: "alert",
        title: "Dagoverzicht",
        deliveryId: value,
      }),
    ).toThrow("Invalid workflow delivery id");
    expect(notifyHelper).not.toHaveBeenCalled();
  });
  it("rejects workflow identifiers on runtime errors", () => {
    expect(() =>
      boot().controller.receive(`Bearer ${token}`, {
        type: "runtime_error",
        detail: "A flow stopped",
        deliveryId,
      }),
    ).toThrow("Invalid workflow delivery id");
  });
  it("restores interleaved timer/workflow histories in one sequence order", () => {
    const first = boot().feed;
    first.recordNodeRedAlert(input);
    first.record({
      topic: "jarvis/events/timer",
      payload: { type: "timer_fired", deliveryId: "abcdef01:1", label: "thee" },
    });
    first.recordNodeRedAlert({
      ...input,
      deliveryId: `nova-workflow:${"c".repeat(64)}`,
    });
    const restarted = boot().feed;
    expect(restarted.recent().events.map((event) => event.seq)).toEqual([
      1, 2, 3,
    ]);
    expect(
      restarted.recent().events.every((event) => event.speakAllowed === false),
    ).toBe(true);
    expect(
      restarted.recordNodeRedAlert({ title: "Volgende melding" })?.seq,
    ).toBe(4);
  });
  it("bounds durable history and rejects malformed stored event rows", () => {
    const journal = new WorkflowFeedJournal(path.join(dir, "history.json"));
    for (let index = 1; index <= 201; index++)
      journal.accept(`nova-workflow:${index.toString(16).padStart(64, "0")}`, {
        seq: index,
        kind: "alert",
        severity: "info",
        title: "Dagoverzicht",
        detail: "",
        at: new Date().toISOString(),
      });
    expect(
      new WorkflowFeedJournal(path.join(dir, "history.json")).read(),
    ).toHaveLength(200);
    const saved = JSON.parse(
      fs.readFileSync(path.join(dir, "history.json"), "utf8"),
    );
    saved.entries[0].event.kind = "timer";
    fs.writeFileSync(path.join(dir, "history.json"), JSON.stringify(saved));
    expect(() =>
      new WorkflowFeedJournal(path.join(dir, "history.json")).read(),
    ).toThrow("Workflow feed history unavailable");
  });
});

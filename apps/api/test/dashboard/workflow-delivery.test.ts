import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { PlanningService } from "../../src/planning/planning.service.js";
import { AlertsFeed } from "../../src/dashboard/alerts-feed.service.js";
import { WorkflowFeedJournal } from "../../src/dashboard/workflow-feed-journal.js";
import { NodeRedEventsController } from "../../src/dashboard/node-red-events.controller.js";
import {
  dbStat,
  failStateWrites,
  stateDoc,
  seedState,
  stateExists,
} from "../helpers/nova-db.js";

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
    expect(first.feed.findWorkflowEvent(deliveryId)).toBeUndefined();
    const original = first.feed.recordNodeRedAlert(input)!;
    expect(first.feed.findWorkflowEvent(deliveryId)?.seq).toBe(original.seq);
    expect(original.speakAllowed).toBe(true);
    expect(first.feed.recordNodeRedAlert(input)?.seq).toBe(original.seq);
    expect(notifyHelper).toHaveBeenCalledOnce();
    const restarted = boot();
    expect(restarted.feed.findWorkflowEvent(deliveryId)?.seq).toBe(
      original.seq,
    );
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
    expect(dbStat(path.join(dir, "workflow-feed.json")).mode & 0o777).toBe(
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
    const failure = failStateWrites(
      path.join(dir, "workflow-feed.json"),
      "ENOSPC private diagnostics",
    );
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
    expect(stateExists(path.join(dir, "spoken-alert-progress.json"))).toBe(
      false,
    );
    failure.mockRestore();
    expect(
      controller.receive(`Bearer ${token}`, { type: "alert", ...input }),
    ).toEqual({ accepted: true });
    expect(feed.recent().events[0]?.speakAllowed).toBe(true);
    expect(notifyHelper).toHaveBeenCalledOnce();
  });
  it("fails closed on corrupt history while ordinary notifications remain available", () => {
    seedState(path.join(dir, "workflow-feed.json"), "corrupt");
    const { controller, feed } = boot();
    expect(() =>
      controller.receive(`Bearer ${token}`, { type: "alert", ...input }),
    ).toThrow("Node-RED alert acceptance unavailable");
    expect(notifyHelper).not.toHaveBeenCalled();
    expect(() => feed.findWorkflowEvent(deliveryId)).toThrow(
      "Workflow feed history unavailable",
    );
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
  it("retains the latest daily and weekly receipt through workflow history churn", () => {
    const file = path.join(dir, "history.json");
    const journal = new WorkflowFeedJournal(file);
    const notice = (seq: number, key: string) => ({
      seq,
      kind: "alert" as const,
      severity: "info" as const,
      title: "Overzicht",
      detail: "",
      key,
      at: new Date().toISOString(),
    });
    const id = (seq: number) =>
      `nova-workflow:${seq.toString(16).padStart(64, "0")}`;
    journal.accept(id(1), notice(1, "daily-highlight-2026-10-13"));
    journal.accept(id(2), notice(2, "weekly-overview-2026-10-11"));
    for (let seq = 3; seq <= 203; seq++)
      journal.accept(id(seq), notice(seq, "briefing"));
    const restarted = new WorkflowFeedJournal(file);
    expect(restarted.read()).toHaveLength(200);
    expect(restarted.find(id(1))).toBeDefined();
    expect(restarted.find(id(2))).toBeDefined();
    expect(restarted.find(id(3))).toBeUndefined();
    restarted.accept(id(204), notice(204, "daily-highlight-2026-10-14"));
    restarted.accept(id(205), notice(205, "weekly-overview-2026-10-18"));
    expect(restarted.find(id(1))).toBeUndefined();
    expect(restarted.find(id(2))).toBeUndefined();
    expect(restarted.find(id(204))).toBeDefined();
    expect(restarted.find(id(205))).toBeDefined();
    expect(restarted.read()).toHaveLength(200);
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
    const saved = stateDoc(path.join(dir, "history.json")) as {
      entries: { event: { kind: string } }[];
    };
    saved.entries[0]!.event.kind = "timer";
    seedState(path.join(dir, "history.json"), saved);
    expect(() =>
      new WorkflowFeedJournal(path.join(dir, "history.json")).read(),
    ).toThrow("Workflow feed history unavailable");
  });
});

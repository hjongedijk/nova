import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { InfrastructureEvent } from "@nova/contracts";
import type { PlanningService } from "../../src/planning/planning.service.js";
import type { WindowsPcService } from "../../src/integrations/windows/windows-pc.service.js";
import type { NtfyPushService } from "../../src/dashboard/ntfy-push.service.js";
import { AlertsFeed } from "../../src/dashboard/alerts-feed.service.js";

const planning = {
  onEvent: () => () => undefined,
} as unknown as PlanningService;
const warning = (title: string): InfrastructureEvent => ({
  topic: "jarvis/alerts",
  payload: { title, detail: "Private detail", severity: "warning" },
});

describe("focus mode", () => {
  it("silences feed and helper while preserving critical push; ends with one summary", () => {
    const notifyHelper = vi.fn(async () => ({ ok: true as const }));
    const notify = vi.fn(async () => undefined);
    const feed = new AlertsFeed(
      planning,
      { configured: true, notifyHelper } as unknown as WindowsPcService,
      undefined,
      { notify } as unknown as NtfyPushService,
    );
    const now = new Date();
    const prior = feed.record(warning("Voor focus"), now)!;
    feed.startFocus(25, now);
    expect(feed.claimSpeech(prior.seq)).toBe(false);
    const during = feed.record(warning("Tijdens focus"), now)!;
    const critical = feed.record(
      {
        topic: "jarvis/alerts",
        payload: { title: "Alarm", severity: "critical" },
      },
      now,
    )!;
    expect(during).toMatchObject({
      speakAllowed: false,
      deliveryMode: "screen",
    });
    expect(critical).toMatchObject({
      speakAllowed: false,
      deliveryMode: "screen",
    });
    expect(feed.claimSpeech(during.seq)).toBe(false);
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notifyHelper).toHaveBeenCalledTimes(1); // the pre-focus event
    expect(feed.focusStatus(now)).toMatchObject({ active: true, pending: 2 });

    feed.endFocus(now);
    expect(feed.focusStatus(now).active).toBe(false);
    expect(feed.recent().events.at(-1)).toMatchObject({
      title: "2 meldingen tijdens focus",
      detail: "Bekijk ze in Meldingen.",
      deliveryMode: "helper",
    });
    expect(notifyHelper).toHaveBeenCalledTimes(2); // one summary
    feed.endFocus(now);
    expect(feed.recent().events).toHaveLength(4);
  });

  it("retains bounded count through restart and closes automatically on expiry", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-focus-"));
    try {
      const config = { dataFile: (name: string) => path.join(directory, name) };
      const now = new Date();
      const first = new AlertsFeed(
        planning,
        undefined,
        undefined,
        undefined,
        undefined,
        config as never,
      );
      first.startFocus(5, now);
      first.record(warning("Private title"), now);
      const file = config.dataFile("focus-mode.json");
      expect(fs.statSync(file).mode & 0o777).toBe(0o600);
      expect(fs.readFileSync(file, "utf8")).not.toContain("Private");

      const restarted = new AlertsFeed(
        planning,
        undefined,
        undefined,
        undefined,
        undefined,
        config as never,
      );
      expect(restarted.focusStatus(now)).toMatchObject({
        active: true,
        pending: 1,
      });
      const ended = restarted.focusStatus(new Date(now.getTime() + 6 * 60_000));
      expect(ended.active).toBe(false);
      expect(restarted.recent().events).toMatchObject([
        { title: "1 melding tijdens focus" },
      ]);
      expect(restarted.focusStatus().active).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it("keeps the focus summary on screen when info notifications are screen-only", () => {
    const notifyHelper = vi.fn(async () => ({ ok: true as const }));
    const feed = new AlertsFeed(
      planning,
      { configured: true, notifyHelper } as unknown as WindowsPcService,
      undefined,
      undefined,
      {
        get: () => ({
          helperPreferences: { notifications: { info: "screen" } },
        }),
      } as never,
    );
    const now = new Date();
    feed.startFocus(25, now);
    feed.record(warning("Tijdens focus"), now);
    feed.endFocus(now);
    expect(feed.recent().events.at(-1)).toMatchObject({
      deliveryMode: "screen",
      speakAllowed: false,
    });
    expect(notifyHelper).not.toHaveBeenCalled();
  });

  it("fails silent on damaged state until explicitly reset", () => {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), "nova-focus-"));
    try {
      const config = { dataFile: (name: string) => path.join(directory, name) };
      fs.writeFileSync(config.dataFile("focus-mode.json"), "{broken");
      const feed = new AlertsFeed(
        planning,
        undefined,
        undefined,
        undefined,
        undefined,
        config as never,
      );
      expect(feed.focusStatus()).toMatchObject({
        active: true,
        needsReset: true,
      });
      expect(feed.record(warning("W"))?.speakAllowed).toBe(false);
      expect(feed.endFocus().active).toBe(false);
      expect(
        new AlertsFeed(
          planning,
          undefined,
          undefined,
          undefined,
          undefined,
          config as never,
        ).focusStatus().active,
      ).toBe(false);
    } finally {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });
});

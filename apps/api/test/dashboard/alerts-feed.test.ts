import { describe, expect, it, vi } from "vitest";
import type { InfrastructureEvent } from "@nova/contracts";
import type { PlanningService } from "../../src/planning/planning.service.js";
import type { SpeechPresenceService } from "../../src/dashboard/speech-presence.service.js";
import type { NtfyPushService } from "../../src/dashboard/ntfy-push.service.js";
import type { WindowsPcService } from "../../src/integrations/windows/windows-pc.service.js";
import { AlertsFeed } from "../../src/dashboard/alerts-feed.service.js";

const event: InfrastructureEvent = {
  topic: "jarvis/alerts",
  payload: {
    title: "Regen komt eraan",
    detail: "Neem een jas mee.",
    severity: "warning",
  },
};

describe("AlertsFeed presence delivery", () => {
  it("keeps the alert visible but marks speech unavailable when home and PC are away", () => {
    const presence = { maySpeak: () => false } as SpeechPresenceService;
    const feed = new AlertsFeed(
      { onEvent: () => () => undefined } as unknown as PlanningService,
      undefined,
      presence,
    );
    feed.record(event);
    expect(feed.recent().events[0]).toMatchObject({
      title: "Regen komt eraan",
      speakAllowed: false,
    });
  });

  it("keeps legacy speech behavior when presence is unknown", () => {
    const presence = { maySpeak: () => null } as SpeechPresenceService;
    const feed = new AlertsFeed(
      { onEvent: () => () => undefined } as unknown as PlanningService,
      undefined,
      presence,
    );
    feed.record(event);
    expect(feed.recent().events[0]).toMatchObject({ speakAllowed: true });
  });

  it("limits unsolicited speech to five events per rolling hour without hiding alerts", () => {
    const feed = new AlertsFeed({
      onEvent: () => () => undefined,
    } as unknown as PlanningService);
    const start = new Date("2026-10-11T12:00:00.000Z");
    for (let index = 0; index < 5; index++)
      feed.record(event, new Date(start.getTime() + index * 60_000));
    feed.record(event, new Date(start.getTime() + 10 * 60_000));

    expect(feed.recent().events).toHaveLength(6);
    expect(
      feed
        .recent()
        .events.slice(0, 5)
        .every((item) => item.speakAllowed),
    ).toBe(true);
    expect(feed.recent().events[5]).toMatchObject({ speakAllowed: false });

    feed.record(event, new Date(start.getTime() + 60 * 60_000));
    expect(feed.recent().events[6]).toMatchObject({ speakAllowed: true });
  });

  it("routes each delivery mode to screen, helper, or speech", () => {
    let warningMode: "screen" | "helper" | "speak" = "screen";
    const notifyHelper = vi.fn(async () => ({
      ok: true as const,
      verified: null,
      result: {},
    }));
    const windows = {
      configured: true,
      notifyHelper,
    } as unknown as WindowsPcService;
    const settings = {
      get: () => ({
        helperPreferences: {
          notifications: {
            info: "screen",
            warning: warningMode,
            critical: "speak",
            timer: "speak",
          },
        },
      }),
    };
    const feed = new AlertsFeed(
      { onEvent: () => () => undefined } as unknown as PlanningService,
      windows,
      undefined,
      undefined,
      settings as never,
    );

    const screen = feed.record(event);
    expect(screen?.speakAllowed).toBe(false);
    expect(notifyHelper).not.toHaveBeenCalled();

    warningMode = "helper";
    const helper = feed.record(event);
    expect(helper?.speakAllowed).toBe(false);
    expect(notifyHelper).toHaveBeenCalledTimes(1);

    warningMode = "speak";
    const speech = feed.record(event);
    expect(speech?.speakAllowed).toBe(true);
    expect(notifyHelper).toHaveBeenCalledTimes(2);
  });

  it("sends only critical alerts to the optional phone push service", () => {
    const ntfy = {
      notify: vi.fn(async () => undefined),
    } as unknown as NtfyPushService;
    const feed = new AlertsFeed(
      { onEvent: () => () => undefined } as unknown as PlanningService,
      undefined,
      undefined,
      ntfy,
    );
    feed.record(event);
    feed.record({
      ...event,
      payload: { ...event.payload, title: "Kritiek", severity: "critical" },
    });
    expect(ntfy.notify).toHaveBeenCalledTimes(1);
    expect(ntfy.notify).toHaveBeenCalledWith(
      expect.objectContaining({ title: "Kritiek", severity: "critical" }),
    );
  });
});

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
  it("allows only one screen to claim speech for an eligible event", () => {
    const feed = new AlertsFeed({
      onEvent: () => () => undefined,
    } as unknown as PlanningService);
    const first = feed.record(event)!;
    expect(feed.claimSpeech(first.seq)).toBe(true);
    expect(feed.claimSpeech(first.seq)).toBe(false);
    expect(feed.claimSpeech(0)).toBe(false);
    expect(feed.claimSpeech(first.seq + 1)).toBe(false);
    const away = new AlertsFeed(
      { onEvent: () => () => undefined } as unknown as PlanningService,
      undefined,
      { maySpeak: () => false } as SpeechPresenceService,
    );
    expect(away.claimSpeech(away.record(event)!.seq)).toBe(false);
  });

  it("summarizes alerts that stayed silent while away when speech becomes available", () => {
    let available = false;
    let onAvailable: () => void = () => undefined;
    const presence = {
      maySpeak: () => available,
      onSpeechAvailable: (listener: () => void) => {
        onAvailable = listener;
        return () => undefined;
      },
    } as unknown as SpeechPresenceService;
    const feed = new AlertsFeed(
      { onEvent: () => () => undefined } as unknown as PlanningService,
      undefined,
      presence,
    );
    feed.onModuleInit();
    const first = feed.record(event)!;
    const second = feed.record({
      ...event,
      payload: { ...event.payload, title: "Tweede waarschuwing" },
    })!;
    expect(first.speakAllowed).toBe(false);
    expect(second.speakAllowed).toBe(false);
    available = true;
    onAvailable();
    expect(feed.recent().events.at(-1)).toMatchObject({
      title: "2 gemiste meldingen",
      speakAllowed: true,
    });
    expect(feed.claimSpeech(feed.recent().latest)).toBe(true);
    onAvailable();
    expect(feed.recent().events).toHaveLength(3);
    feed.onModuleDestroy();
  });

  it("does not revive old alerts or alerts switched to screen-only mode", () => {
    let onAvailable: () => void = () => undefined;
    const presence = {
      maySpeak: () => false,
      onSpeechAvailable: (listener: () => void) => {
        onAvailable = listener;
        return () => undefined;
      },
    } as unknown as SpeechPresenceService;
    let mode: "speak" | "screen" = "speak";
    const settings = {
      get: () => ({ helperPreferences: { notifications: { warning: mode } } }),
    };
    const feed = new AlertsFeed(
      { onEvent: () => () => undefined } as unknown as PlanningService,
      undefined,
      presence,
      undefined,
      settings as never,
    );
    feed.onModuleInit();
    feed.record(event, new Date(Date.now() - 5 * 60 * 60_000));
    feed.record({ ...event, payload: { ...event.payload, title: "Recent" } });
    mode = "screen";
    Object.assign(presence, { maySpeak: () => true });
    onAvailable();
    expect(feed.recent().events).toHaveLength(2);
    feed.onModuleDestroy();
  });
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
      feed.record(
        { ...event, payload: { ...event.payload, title: `Melding ${index}` } },
        new Date(start.getTime() + index * 60_000),
      );
    feed.record(
      { ...event, payload: { ...event.payload, title: "Melding 5" } },
      new Date(start.getTime() + 10 * 60_000),
    );

    expect(feed.recent().events).toHaveLength(6);
    expect(
      feed
        .recent()
        .events.slice(0, 5)
        .every((item) => item.speakAllowed),
    ).toBe(true);
    expect(feed.recent().events[5]).toMatchObject({ speakAllowed: false });

    feed.record(
      { ...event, payload: { ...event.payload, title: "Melding 6" } },
      new Date(start.getTime() + 60 * 60_000),
    );
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
    expect(screen).toMatchObject({
      speakAllowed: false,
      deliveryMode: "screen",
    });
    expect(notifyHelper).not.toHaveBeenCalled();

    warningMode = "helper";
    const helper = feed.record({
      ...event,
      payload: { ...event.payload, title: "Een tweede melding" },
    });
    expect(helper).toMatchObject({
      speakAllowed: false,
      deliveryMode: "helper",
    });
    expect(notifyHelper).toHaveBeenCalledTimes(1);

    warningMode = "speak";
    const speech = feed.record({
      ...event,
      payload: { ...event.payload, title: "Een derde melding" },
    });
    expect(speech).toMatchObject({ speakAllowed: true, deliveryMode: "speak" });
    expect(notifyHelper).toHaveBeenCalledTimes(2);
  });

  it("gives briefings their own spoken mode without changing ordinary info alerts", () => {
    let briefingMode: "screen" | "speak" = "speak";
    let present = true;
    const settings = {
      get: () => ({
        helperPreferences: {
          notifications: {
            info: "helper",
            briefing: briefingMode,
            warning: "speak",
            critical: "speak",
            timer: "speak",
          },
        },
      }),
    };
    const feed = new AlertsFeed(
      { onEvent: () => () => undefined } as unknown as PlanningService,
      undefined,
      { maySpeak: () => present } as SpeechPresenceService,
      undefined,
      settings as never,
    );
    expect(
      feed.recordNodeRedAlert({ title: "Gewone info" })?.speakAllowed,
    ).toBe(false);
    expect(
      feed.recordNodeRedAlert({
        title: "Ochtendbriefing",
        category: "briefing",
      }),
    ).toMatchObject({ key: "briefing", speakAllowed: true });
    briefingMode = "screen";
    expect(
      feed.recordNodeRedAlert({ title: "Stil overzicht", category: "briefing" })
        ?.speakAllowed,
    ).toBe(false);
    briefingMode = "speak";
    present = false;
    expect(
      feed.recordNodeRedAlert({ title: "Niemand thuis", category: "briefing" })
        ?.speakAllowed,
    ).toBe(false);
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

  it("bundles repeating non-critical alerts without muting critical alerts or timers", () => {
    const notifyHelper = vi.fn(async () => ({
      ok: true as const,
      verified: null,
      result: {},
    }));
    const windows = {
      configured: true,
      notifyHelper,
    } as unknown as WindowsPcService;
    const feed = new AlertsFeed(
      { onEvent: () => () => undefined } as unknown as PlanningService,
      windows,
    );
    const start = new Date("2026-10-11T12:00:00.000Z");
    const first = feed.record(event, start);
    const second = feed.record(event, new Date(start.getTime() + 60_000));
    expect(second?.seq).toBe(first?.seq);
    expect(feed.recent().events).toHaveLength(1);
    const summary = feed.record(event, new Date(start.getTime() + 120_000));
    expect(summary).toMatchObject({
      title: "Regen komt eraan (3 keer in 10 minuten)",
      speakAllowed: false,
      deliveryMode: "screen",
    });
    expect(feed.recent(first!.seq).events).toEqual([summary]);
    feed.record(event, new Date(start.getTime() + 180_000));
    expect(feed.recent().events).toHaveLength(2);
    expect(notifyHelper).toHaveBeenCalledTimes(1);
    const critical = {
      ...event,
      payload: { ...event.payload, severity: "critical" },
    };
    feed.record(critical, new Date(start.getTime() + 190_000));
    feed.record(critical, new Date(start.getTime() + 200_000));
    expect(feed.recent().events).toHaveLength(4);
    const timer: InfrastructureEvent = {
      topic: "jarvis/events/timer",
      payload: { type: "timer_fired", label: "Eten" },
    };
    feed.record(timer, new Date(start.getTime() + 210_000));
    feed.record(timer, new Date(start.getTime() + 220_000));
    expect(feed.recent().events).toHaveLength(6);
    const afterWindow = feed.record(
      event,
      new Date(start.getTime() + 11 * 60_000),
    );
    expect(afterWindow?.title).toBe("Regen komt eraan");
    expect(feed.recent().events).toHaveLength(7);
  });
});

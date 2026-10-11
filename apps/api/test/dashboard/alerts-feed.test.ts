import { describe, expect, it } from "vitest";
import type { InfrastructureEvent } from "@nova/contracts";
import type { PlanningService } from "../../src/planning/planning.service.js";
import type { SpeechPresenceService } from "../../src/dashboard/speech-presence.service.js";
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
    expect(feed.recent().events[0]).not.toHaveProperty("speakAllowed");
  });
});

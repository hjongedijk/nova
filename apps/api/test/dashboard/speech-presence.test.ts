import { describe, expect, it, vi } from "vitest";
import type { HomeAssistantService } from "../../src/home/home-assistant.service.js";
import type { WindowsPcService } from "../../src/integrations/windows/windows-pc.service.js";
import { SpeechPresenceService } from "../../src/dashboard/speech-presence.service.js";

function service(states: string[], helperOpen: boolean | null) {
  const home = {
    configured: true,
    sync: vi.fn(async () => undefined),
    health: () => ({ online: true }),
    visibleEntities: () =>
      states.map((state, index) => ({
        domain: "person",
        entity_id: `person.user_${index}`,
        state,
      })),
  } as unknown as HomeAssistantService;
  const windows = {
    settingsStatus: vi.fn(async () => ({
      available: helperOpen !== null,
      helperOpen,
    })),
  } as unknown as WindowsPcService;
  return new SpeechPresenceService(home, windows);
}

describe("SpeechPresenceService", () => {
  it("allows speech at home or when the helper is open", async () => {
    const home = service(["home"], false);
    await home.refresh();
    expect(home.maySpeak()).toBe(true);

    const pc = service(["not_home"], true);
    await pc.refresh();
    expect(pc.maySpeak()).toBe(true);
  });

  it("suppresses unsolicited speech only when the sole person is away and helper is closed", async () => {
    const away = service(["not_home"], false);
    await away.refresh();
    expect(away.maySpeak()).toBe(false);
  });

  it("does not guess a person or suppress speech when presence is ambiguous or unknown", async () => {
    const ambiguous = service(["home", "not_home"], false);
    await ambiguous.refresh();
    expect(ambiguous.maySpeak()).toBe(null);

    const unknown = service([], null);
    await unknown.refresh();
    expect(unknown.maySpeak()).toBe(null);
  });

  it("reports confirmed transitions and ignores initial unknown-to-away readings", async () => {
    const states = ["not_home"];
    const away = service(states, false);
    const transitions: Array<[string, string]> = [];
    away.onTransition((from, to) => transitions.push([from, to]));
    await away.refresh();
    expect(transitions).toEqual([]);

    states[0] = "home";
    await away.refresh();
    states[0] = "not_home";
    await away.refresh();
    expect(transitions).toEqual([
      ["away", "home"],
      ["home", "away"],
    ]);
  });

  it("signals when speech becomes available after absence", async () => {
    const states = ["not_home"];
    const presence = service(states, false);
    const available = vi.fn();
    presence.onSpeechAvailable(available);
    await presence.refresh();
    expect(available).not.toHaveBeenCalled();
    states[0] = "home";
    await presence.refresh();
    expect(available).toHaveBeenCalledTimes(1);
    await presence.refresh();
    expect(available).toHaveBeenCalledTimes(1);
  });
});

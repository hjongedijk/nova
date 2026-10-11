import { afterEach, describe, expect, it, vi } from "vitest";
import { extractAssistantMood } from "../../src/chat/assistant-mood.js";
import { OmniRouteClient } from "../../src/chat/omniroute-client.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { RoutingService } from "../../src/routing/routing.service.js";

afterEach(() => vi.unstubAllGlobals());

describe("assistant mood marker", () => {
  it.each([
    ["happy", "happy"],
    ["thoughtful", "thoughtful"],
    ["concerned", "concerned"],
    ["enthusiastic", "enthusiastic"],
    ["neutral", "neutral"],
  ] as const)("extracts %s without showing the marker", (marker, mood) => {
    expect(
      extractAssistantMood(`<!--NOVA_MOOD:${marker}-->\nGoed nieuws.`),
    ).toEqual({ content: "Goed nieuws.", mood, matched: true });
  });

  it("defaults to neutral and leaves ordinary answer text intact", () => {
    expect(extractAssistantMood("Gewoon antwoord.")).toEqual({
      content: "Gewoon antwoord.",
      mood: "neutral",
      matched: false,
    });
  });

  it("strips invalid and non-terminal private markers without assigning a mood", () => {
    expect(extractAssistantMood("<!--NOVA_MOOD:angry--> antwoord")).toEqual({
      content: " antwoord",
      mood: "neutral",
      matched: false,
    });
    expect(
      extractAssistantMood("antwoord <!--NOVA_MOOD:happy--> extra"),
    ).toEqual({ content: "antwoord  extra", mood: "neutral", matched: false });
  });

  it("keeps a split streaming marker out of visible answer tokens", async () => {
    const chunks = [
      `data: ${JSON.stringify({ choices: [{ delta: { content: "<!--NOVA_MOOD:hap" } }] })}\n\n`,
      `data: ${JSON.stringify({ choices: [{ delta: { content: "py-->Goed nieuws." } }] })}\n\n`,
      "data: [DONE]\n\n",
    ];
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks)
          controller.enqueue(new TextEncoder().encode(chunk));
        controller.close();
      },
    });
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue(
        new Response(body, {
          status: 200,
          headers: { "content-type": "text/event-stream" },
        }),
      ),
    );
    const client = new OmniRouteClient(
      {
        omniUrl: "http://gateway.test/v1",
        omniKey: "test",
        omniModel: "auto",
        omniCompression: "off",
      } as NovaConfig,
      { assertFree: () => ({}) } as RoutingService,
    );
    const events: { event: string; text?: string; mood?: string }[] = [];
    const result = await client.call([{ role: "user", content: "Hoi" }], {
      stream: true,
      includeMood: true,
      emit: (event, data) => events.push({ event, ...data }),
    });
    expect(result.assistant.content).toBe("Goed nieuws.");
    expect(result.mood).toBe("happy");
    expect(events.find((event) => event.event === "mood")?.mood).toBe("happy");
    expect(
      events
        .filter((event) => event.event === "token")
        .map((event) => event.text)
        .join(""),
    ).toBe("Goed nieuws.");
  });
});

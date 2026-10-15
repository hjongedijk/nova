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

  it.each([
    ["leading whitespace", " \n<!--NOVA_MOOD:happy-->", "Goed nieuws.", ""],
    ["case-insensitive header", "<!--nova_mood:HAPPY-->", "Goed nieuws.", ""],
    ["continuation tail", "<!--NOVA_MOOD:happy-->", "Goed nieuws.", " Klaar."],
  ])(
    "streams %s before upstream completion without losing text",
    async (_case, header, first, tail) => {
      let controller!: ReadableStreamDefaultController<Uint8Array>;
      const body = new ReadableStream<Uint8Array>({
        start(value) {
          controller = value;
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(body, {
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
      const tokens: string[] = [];
      const result = client.call([{ role: "user", content: "Hoi" }], {
        stream: true,
        includeMood: true,
        emit: (event, data) => {
          if (event === "token") tokens.push(String(data.text));
        },
      });
      const send = (content: string) =>
        controller.enqueue(
          new TextEncoder().encode(
            `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
          ),
        );
      send(header + first);
      send(tail);
      let answer;
      try {
        await vi.waitFor(
          () => expect(tokens.join("").trim()).toContain(first),
          { timeout: 300 },
        );
      } finally {
        controller.enqueue(new TextEncoder().encode("data: [DONE]\n\n"));
        controller.close();
        answer = await result;
      }
      expect(answer.assistant.content).toBe(first + tail);
      expect(tokens.join("").trim()).toBe(first + tail);
    },
  );

  it.each([
    ["plain short reply", ["Hoi", "!"], "Hoi!", "neutral"],
    [
      "split mixed-case header",
      [" \n", "<!--no", "va_mood:Hap", "py-->", "Goed", " nieuws."],
      "Goed nieuws.",
      "happy",
    ],
    [
      "noninitial header",
      ["Antwoord ", "<!--NOVA_MOOD:happy-->", " klaar."],
      "Antwoord  klaar.",
      "neutral",
    ],
    [
      "invalid initial header",
      ["<!--NOVA_MOOD:angry-->", "Antwoord."],
      "Antwoord.",
      "neutral",
    ],
    [
      "second header",
      [
        "<!--NOVA_MOOD:happy-->",
        "Antwoord ",
        "<!--NOVA_MOOD:concerned-->",
        "klaar.",
      ],
      "Antwoord klaar.",
      "happy",
    ],
    ["ordinary less-than", ["Drie <", " vier."], "Drie < vier.", "neutral"],
  ] as const)(
    "preserves %s across stream boundaries",
    async (_case, fragments, expected, mood) => {
      const encode = new TextEncoder();
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          for (const content of fragments)
            controller.enqueue(
              encode.encode(
                `data: ${JSON.stringify({ choices: [{ delta: { content } }] })}\n\n`,
              ),
            );
          controller.enqueue(encode.encode("data: [DONE]\n\n"));
          controller.close();
        },
      });
      vi.stubGlobal(
        "fetch",
        vi.fn().mockResolvedValue(
          new Response(body, {
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
      const tokens: string[] = [];
      const moods: unknown[] = [];
      const answer = await client.call([{ role: "user", content: "Hoi" }], {
        stream: true,
        includeMood: true,
        emit: (event, data) => {
          if (event === "token") tokens.push(String(data.text));
          if (event === "mood") moods.push(data.mood);
        },
      });
      expect(answer.assistant.content).toBe(expected);
      expect(tokens.join("").trim()).toBe(expected);
      expect(answer.mood).toBe(mood);
      expect(moods).toEqual(mood === "neutral" ? [] : [mood]);
    },
  );
});

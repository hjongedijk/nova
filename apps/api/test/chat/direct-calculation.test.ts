import { describe, expect, it, vi } from "vitest";
import { directCalculation } from "../../src/chat/direct-calculation.js";
import {
  directConversion,
  directConversionReply,
} from "../../src/chat/direct-conversion.js";
import {
  directDefinitionQuery,
  directDefinitionReply,
} from "../../src/chat/direct-definition.js";
import {
  directCurrencyQuery,
  directCurrencyReply,
} from "../../src/chat/direct-currency.js";
import { OrchestratorService } from "../../src/chat/orchestrator.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { RoutingService } from "../../src/routing/routing.service.js";
import type { ToolsService } from "../../src/tools/tools.service.js";
import type { OmniRouteClient } from "../../src/chat/omniroute-client.service.js";
import type { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import type { ConfirmationHandler } from "../../src/chat/confirmation-handler.service.js";
import type { ContextBuilder } from "../../src/chat/context-builder.service.js";

describe("direct calculator requests", () => {
  it.each([
    ["Bereken 17 * 23", 391],
    ["Hoeveel is 15 procent van 240?", 36],
    ["What is 12 plus 9?", 21],
    ["Calculate (2 + 3)^2 / 4", 6.25],
  ])("recognizes %s", (message, expected) => {
    expect(directCalculation(message)).toBe(expected);
  });

  it.each([
    "Wat kost een fiets van 240 euro?",
    "How much does a 240 euro bike cost?",
    "What is the weather in Amsterdam?",
    "Bereken de prijs inclusief btw",
    "Calculate 1 / 0",
  ])("leaves non-calculator question for normal chat: %s", (message) => {
    expect(directCalculation(message)).toBeNull();
  });

  it.each([
    ["Hoeveel is 10 km in miles?", 6.213711, "mile"],
    ["Convert 20 degrees Celsius to Fahrenheit", 68, "Fahrenheit"],
    ["Zet 2 kg om naar pounds", 4.409245, "pound"],
    ["Convert 2 miles to kilometers", 3.218688, "kilometer"],
    ["Convert 1 liter to milliliters", 1000, "milliliter"],
    ["Convert 36 km/h to mph", 22.3693629, "mile per hour"],
    ["Convert 1 GB to MB", 1000, "megabyte"],
    ["Convert 1 minute to seconds", 60, "second"],
  ])("converts %s locally", (message, value, unit) => {
    const result = directConversion(message);
    expect(result?.value).toBeCloseTo(value as number, 5);
    expect(result?.unit).toBe(unit);
  });

  it.each([
    "Convert 10 meters to kilograms",
    "How far is 10?",
    "Convert 10 xyz to meters",
  ])("does not guess an unsupported conversion: %s", (message) => {
    expect(directConversion(message)).toBeNull();
  });

  it("formats conversion results for the active language", () => {
    const result = directConversion("Hoeveel is 10 km in miles?");
    expect(result).not.toBeNull();
    expect(directConversionReply(result!, "nl")).toBe("6,213712 mijl.");
    expect(directConversionReply(result!, "en")).toBe("6.213712 mile.");
  });

  it.each([
    ["Wat betekent fotosynthese?", "fotosynthese", "nl"],
    ["Zoek op Mount Everest", "Mount Everest", "nl"],
    ["Define photosynthesis", "photosynthesis", "en"],
    ["Look up photosynthesis", "photosynthesis", "en"],
    ["What does gravity mean?", "gravity", "en"],
  ])(
    "recognizes explicit definition request %s",
    (message, query, language) => {
      expect(directDefinitionQuery(message)).toEqual({ query, language });
    },
  );

  it.each([
    "Wat gebeurt er vandaag?",
    "Define https://example.com/private",
    "What does user@example.com mean?",
  ])(
    "does not send an ordinary or private query to Wikipedia: %s",
    (message) => {
      expect(directDefinitionQuery(message)).toBeNull();
    },
  );

  it("answers from a bounded Wikipedia summary and adds a source link only in text", () => {
    const result = {
      title: "Fotosynthese",
      summary: "Fotosynthese is de omzetting van licht in chemische energie.",
      url: "https://nl.wikipedia.org/wiki/Fotosynthese",
    };
    expect(directDefinitionReply(result, "nl")).toContain(
      "Volgens Wikipedia: Fotosynthese.",
    );
    expect(directDefinitionReply(result, "nl")).toContain(
      "[Fotosynthese](https://nl.wikipedia.org/wiki/Fotosynthese)",
    );
    expect(directDefinitionReply(result, "nl", true)).not.toContain("https://");
  });

  it.each([
    ["Convert 10 EUR to USD", 10, "EUR", "USD", "en"],
    ["Converteer 25,5 USD naar EUR", 25.5, "USD", "EUR", "nl"],
  ])(
    "recognizes explicit currency request %s",
    (message, amount, from, to, language) => {
      expect(directCurrencyQuery(message)).toEqual({
        amount,
        from,
        to,
        language,
      });
    },
  );

  it("does not guess currency words without three-letter codes", () => {
    expect(directCurrencyQuery("Convert 10 pounds to euros")).toBeNull();
  });

  it("includes source and date in a localized currency result", () => {
    expect(
      directCurrencyReply(
        {
          amount: 10,
          from: "EUR",
          to: "USD",
          converted: 11.25,
          source: "European Central Bank",
          date: "2026-10-12",
        },
        "en",
      ),
    ).toBe("10 EUR = 11.25 USD (European Central Bank (2026-10-12)).");
  });

  function harness() {
    const client = {
      call: vi.fn().mockResolvedValue({
        assistant: { role: "assistant", content: "model response" },
        model: "fixture",
        usage: null,
      }),
    } as unknown as OmniRouteClient;
    const confirmations = {
      cancel: vi.fn(),
    } as unknown as ConfirmationsService;
    const confirmationHandler = {
      handle: vi.fn().mockResolvedValue(null),
    } as unknown as ConfirmationHandler;
    const context = {
      build: vi.fn().mockResolvedValue([
        { role: "system", content: "system" },
        { role: "user", content: "question" },
      ]),
    } as unknown as ContextBuilder;
    const tools = {
      list: vi.fn().mockReturnValue([]),
      forModel: vi.fn().mockReturnValue([]),
      execute: vi.fn().mockImplementation((name: string) =>
        Promise.resolve(
          name === "wikipedia"
            ? {
                ok: true,
                result: {
                  title: "Photosynthesis",
                  summary: "Plants convert light into chemical energy.",
                  url: "https://en.wikipedia.org/wiki/Photosynthesis",
                },
              }
            : {
                ok: true,
                result: {
                  amount: 10,
                  from: "EUR",
                  to: "USD",
                  rate: 1.125,
                  converted: 11.25,
                  date: "2026-10-12",
                  source: "European Central Bank",
                },
              },
        ),
      ),
    } as unknown as ToolsService;
    const routing = {
      assertFree: vi.fn(),
      preferredModelForRole: vi.fn(),
    } as unknown as RoutingService;
    const service = new OrchestratorService(
      { maxToolRounds: 4 } as NovaConfig,
      client,
      routing,
      tools,
      confirmations,
      confirmationHandler,
      context,
    );
    return { service, client, confirmations, context, routing, tools };
  }

  it("answers typed arithmetic locally without routing or building model context", async () => {
    const { service, client, confirmations, context, routing } = harness();
    const reply = await service.run({
      sessionId: "local-math",
      message: "Bereken 17 * 23",
    });
    expect(reply.reply).toBe("Het antwoord is 391.");
    expect(reply.model).toBeNull();
    expect(reply.usage).toBeNull();
    expect(client.call).not.toHaveBeenCalled();
    expect(context.build).not.toHaveBeenCalled();
    expect(routing.assertFree).not.toHaveBeenCalled();
    expect(confirmations.cancel).toHaveBeenCalledWith("local-math");
  });

  it("emits a localized token for streamed English arithmetic", async () => {
    const { service, client } = harness();
    const events: { event: string; data: Record<string, unknown> }[] = [];
    const reply = await service.run({
      sessionId: "stream-math",
      message: "What is 12 plus 9?",
      responseLanguage: "en",
      stream: true,
      emit: (event, data) => events.push({ event, data }),
    });
    expect(reply.reply).toBe("The answer is 21.");
    expect(events).toEqual([
      { event: "route", data: { role: "conversation" } },
      { event: "token", data: { text: "The answer is 21." } },
    ]);
    expect(client.call).not.toHaveBeenCalled();
  });

  it("uses the read-only Wikipedia tool directly for explicit English definitions", async () => {
    const { service, client, context, routing, tools } = harness();
    const reply = await service.run({
      sessionId: "direct-definition",
      message: "Define photosynthesis",
      responseLanguage: "en",
    });
    expect(reply.reply).toContain("According to Wikipedia: Photosynthesis.");
    expect(reply.reply).toContain(
      "[Photosynthesis](https://en.wikipedia.org/wiki/Photosynthesis)",
    );
    expect(reply.model).toBeNull();
    expect(vi.mocked(tools.execute).mock.calls[0]?.slice(0, 3)).toEqual([
      "wikipedia",
      { query: "photosynthesis", language: "en" },
      "direct-definition",
    ]);
    expect(client.call).not.toHaveBeenCalled();
    expect(context.build).not.toHaveBeenCalled();
    expect(routing.assertFree).not.toHaveBeenCalled();
  });

  it("uses the current exchange-rate tool directly without an LLM call", async () => {
    const { service, client, tools, routing } = harness();
    const reply = await service.run({
      sessionId: "direct-currency",
      message: "Convert 10 EUR to USD",
    });
    expect(reply.reply).toContain("10 EUR = 11.25 USD");
    expect(reply.reply).toContain("European Central Bank (2026-10-12)");
    expect(vi.mocked(tools.execute).mock.calls[0]?.slice(0, 3)).toEqual([
      "currency_convert",
      { amount: 10, from: "EUR", to: "USD" },
      "direct-currency",
    ]);
    expect(client.call).not.toHaveBeenCalled();
    expect(routing.assertFree).not.toHaveBeenCalled();
  });

  it("does not send secret-shaped terms to Wikipedia", async () => {
    const { service, tools, client } = harness();
    const reply = await service.run({
      sessionId: "private-definition",
      message: "Define password: hunter2",
    });
    expect(reply.reply).toContain("sensitive information");
    expect(tools.execute).not.toHaveBeenCalled();
    expect(client.call).not.toHaveBeenCalled();
  });

  it("keeps attachment questions and ambiguous requests on normal chat", async () => {
    const { service, client } = harness();
    await service.run({
      sessionId: "file-math",
      message: "Bereken 17 * 23",
      attachments: [
        { name: "work.txt", mimeType: "text/plain", content: "17 * 23" },
      ],
    });
    await service.run({
      sessionId: "ambiguous-math",
      message: "Wat kost een fiets van 240 euro?",
    });
    expect(client.call).toHaveBeenCalledTimes(2);
  });
});

import { describe, expect, it, vi } from "vitest";
import type { Risk } from "@nova/contracts";
import {
  OrchestratorService,
  requiresLiveData,
} from "../../src/chat/orchestrator.service.js";
import type { ToolResult } from "../../src/tools/tool.types.js";

const invented = "Invented current temperature19°C, everything completed.";
const unavailable = (language: "nl" | "en") =>
  language === "en"
    ? "I could not complete your request right now. Please try again later."
    : "Ik kon je verzoek nu niet afronden. Probeer het straks nog eens.";
interface Round {
  text?: string;
  tools?: string[];
  error?: boolean;
  abort?: boolean;
}
function fixture(
  rounds: Round[],
  options: { noTools?: boolean; result?: ToolResult; risk?: Risk } = {},
) {
  let cursor = 0;
  const controller = new AbortController();
  const definitions = options.noTools
    ? []
    : [
        {
          name: "fixture_live",
          function: { name: "fixture_live" },
          risk: options.risk ?? "READ_ONLY",
          enabled: true,
        },
        {
          name: "nova_tools_search",
          function: { name: "nova_tools_search" },
          risk: "READ_ONLY",
          enabled: true,
        },
      ];
  const call = vi.fn(async (_messages, config) => {
    const round = rounds[cursor++];
    if (!round) throw new Error("Unexpected fixture model call");
    if (round.abort) controller.abort();
    if (round.error) throw new Error("Synthetic private gateway error");
    if (config.stream && round.text) {
      config.emit("token", { text: round.text });
      config.emit("mood", { mood: "happy" });
    }
    return {
      assistant: {
        role: "assistant",
        content: round.text ?? "",
        ...(round.tools
          ? {
              tool_calls: round.tools.map((name) => ({
                id: `${cursor}-${name}`,
                type: "function",
                function: {
                  name,
                  arguments:
                    name === "nova_tools_search" ? '{"query":"weather"}' : "{}",
                },
              })),
            }
          : {}),
      },
      model: "fixture",
      usage: null,
      metadata: {},
      mood: "happy",
    };
  });
  const execute = vi.fn(async (name: string): Promise<ToolResult> =>
    name === "nova_tools_search"
      ? { ok: true, result: { tools: [] } }
      : (options.result ?? { ok: true, result: { temperature: 19 } }),
  );
  const service = new OrchestratorService(
    { maxToolRounds: 5 } as never,
    { call } as never,
    {
      assertFree: () => ({ ready: true }),
      preferredModelForRole: () => undefined,
    } as never,
    {
      list: () => definitions,
      forModel: () => definitions,
      expandModelTools: () => definitions,
      execute,
    } as never,
    { cancel: vi.fn() } as never,
    { handle: async () => null } as never,
    {
      build: async () => [
        { role: "system", content: "Synthetic fixture." },
        { role: "user", content: "Synthetic request." },
      ],
    } as never,
  );
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const run = (
    language: "nl" | "en",
    stream: boolean,
    message = "Wat is nu de temperatuur buiten?",
    attachments = false,
  ) =>
    service.run({
      sessionId: "required-evidence-fixture",
      message,
      responseLanguage: language,
      stream,
      signal: controller.signal,
      emit: (event, data) => events.push({ event, data }),
      ...(attachments
        ? {
            attachments: [
              {
                name: "weather.txt",
                content: "Synthetic historical weather data.",
              },
            ],
          }
        : {}),
    });
  return { call, execute, run, events };
}
const text = (test: ReturnType<typeof fixture>) =>
  test.events
    .filter(({ event }) => event === "token")
    .map(({ data }) => data.text)
    .join("");

const conceptual = [
  "Leg uit hoe een timer werkt",
  "Kun je uitleggen hoe regen ontstaat?",
  "Explain how weather forecasting works",
  "Schrijf Python-code die serverstatus simuleert",
  "Write a script to restart a server",
  "Write Python code for a weather simulation.",
  "Wat is de functie van een thermostaat?",
  "Wat betekent open source?",
  "Ik ben moe van het slechte weer",
  "How much do you know about Python?",
  "How much is enough?",
  "Wat kost een fiets van 240 euro?",
  "Wat kost een stoel van 35,50 euro?",
  "How much does a 240 euro bike cost?",
  "How much does a 35 dollar chair cost?",
  "I'm tired of this weather, please just listen.",
];
const live = [
  "Wat is nu de temperatuur?",
  "Wat kost die fiets nu?",
  "How much does that bike cost today?",
  "Check actuele prijs van fiets van 240 euro",
  "How much is 240 euro worth in dollars?",
  "What is the weather now?",
  "What time is it?",
  "What is in my calendar today?",
  "Wat staat er vandaag in mijn agenda?",
  "What is the latest news?",
  "Turn on the living room lights",
  "Zet de lamp aan",
  "Ik ben gestrest, wat is nu de temperatuur?",
  "I'm tired; turn off the lights",
  "Explain why my server is down right now",
  "Leg uit waarom mijn lamp nu niet reageert",
  "Run the Python script and check my server status",
  "Voer het script uit en herstart de server",
  "Write a script, then run it to restart my server",
  "I am tired, switch off the lights",
  "Please add milk to my shopping list",
  "Ik ben moe, voeg melk toe aan boodschappen",
  "Remind me to buy milk",
  "I'm tired, please check weather now",
  "Run this code",
  "Write code, then run it",
  "Fetch the public records",
];
describe("live-data intent boundaries", () => {
  it.each(conceptual)(
    "keeps conceptual/code/personal request tool-optional: %s",
    (message) => expect(requiresLiveData(message)).toBe(false),
  );
  it.each(live)("requires execution evidence: %s", (message) =>
    expect(requiresLiveData(message)).toBe(true),
  );
  it.each([
    "Vat het nieuws in dit bestand samen",
    "Explain the current implementation in this file",
    "What does this news article say?",
    "Check the weather report in this file",
  ])("uses attachment content without a live lookup: %s", (message) =>
    expect(requiresLiveData(message, true)).toBe(false),
  );
  it("retains mixed document analysis and outside live checks", () =>
    expect(
      requiresLiveData("Read this file and check weather outside now", true),
    ).toBe(true));
  it("retains explicit live checks with an attachment", () =>
    expect(requiresLiveData("Check the server status now", true)).toBe(true));
});

describe.each(["nl", "en"] as const)(
  "required %s operational evidence",
  (language) => {
    describe.each([false, true])("stream=%s", (stream) => {
      it.each([
        {
          name: "ignores required twice",
          rounds: [{ text: invented }, { text: invented }],
        },
        {
          name: "required unsupported, auto and reminder ignored",
          rounds: [{ error: true }, { text: invented }, { text: invented }],
        },
        {
          name: "discovery only",
          rounds: [
            { tools: ["nova_tools_search"] },
            { text: invented },
            { text: invented },
          ],
        },
        {
          name: "empty result after required attempts",
          rounds: [{ text: "" }, { text: "" }],
        },
        {
          name: "invented unknown tool",
          rounds: [{ tools: ["invented_tool"] }, { text: invented }],
        },
      ])("blocks $name before text/mood reach caller", async ({ rounds }) => {
        const test = fixture(rounds);
        const response = await test.run(language, stream);
        expect(response.reply).toBe(unavailable(language));
        expect(response.unavailable).toBe(true);
        expect(text(test)).toBe(stream ? response.reply : "");
        expect(test.events.some(({ event }) => event === "mood")).toBe(false);
        expect(response).not.toHaveProperty("mood");
        expect(JSON.stringify({ response, events: test.events })).not.toContain(
          invented,
        );
      });
      it.each([
        "Write a script, then run it to restart my server",
        "I am tired, switch off the lights",
        "Please add milk to my shopping list",
        "Ik ben moe, voeg melk toe aan boodschappen",
        "Remind me to buy milk",
        "Run this code",
        "Write code, then run it",
        "Fetch the public records",
      ])(
        "blocks invented completion without evidence for%s",
        async (message) => {
          const test = fixture([{ text: invented }, { text: invented }]);
          const response = await test.run(language, stream, message);
          expect(response.reply).toBe(unavailable(language));
          expect(response.unavailable).toBe(true);
          expect(text(test)).toBe(stream ? response.reply : "");
          expect(test.events.some(({ event }) => event === "mood")).toBe(false);
        },
      );
      it("keeps attached report checking tool-optional", async () => {
        const test = fixture(
          [{ text: "The attached report lists historical temperatures." }],
          { noTools: true },
        );
        const response = await test.run(
          language,
          stream,
          "Check the weather report in this file",
          true,
        );
        expect(response.reply).toBe(
          "The attached report lists historical temperatures.",
        );
        expect(response.unavailable).toBeUndefined();
        expect(text(test)).toBe(stream ? response.reply : "");
      });
      it("returns unavailable without invoking a model when no tools exist", async () => {
        const test = fixture([], { noTools: true });
        const response = await test.run(language, stream);
        expect(response.reply).toBe(unavailable(language));
        expect(response.unavailable).toBe(true);
        expect(response.model).toBeNull();
        expect(test.call).not.toHaveBeenCalled();
        expect(text(test)).toBe(stream ? response.reply : "");
      });
      it.each(["READ_ONLY", "SAFE", "CONFIRM", "DANGEROUS"] as const)(
        "allows narration after successful known%s tool",
        async (risk) => {
          const test = fixture(
            [
              { tools: ["fixture_live"], text: "Speculative preface" },
              { text: "Verified useful result." },
            ],
            { risk, result: { ok: true, verified: true } },
          );
          const response = await test.run(language, stream);
          expect(response.reply).toBe("Verified useful result.");
          expect(text(test)).toBe(stream ? response.reply : "");
          expect(test.execute).toHaveBeenCalledOnce();
        },
      );
      it("preserves mutation failure ownership", async () => {
        const test = fixture([{ tools: ["fixture_live"] }], {
          risk: "SAFE",
          result: { ok: false },
        });
        const response = await test.run(language, stream);
        expect(response.reply).toBe(
          language === "en"
            ? "The action failed. Check the current state before trying again."
            : "De actie is niet gelukt. Controleer de huidige toestand voordat je het opnieuw probeert.",
        );
        expect(text(test)).toBe(stream ? response.reply : "");
        expect(test.call).toHaveBeenCalledOnce();
      });
      it("preserves pending confirmation without pretending to execute", async () => {
        const action = {
          id: "confirmation-fixture",
          tool: "fixture_live",
          args: {},
          risk: "CONFIRM",
          summary: "Synthetic change",
          createdAt: "2026-10-15T00:00:00Z",
          expiresAt: "2026-10-15T01:00:00Z",
        };
        const test = fixture([{ tools: ["fixture_live"] }], {
          risk: "CONFIRM",
          result: {
            ok: false,
            requiresConfirmation: true,
            action: action as never,
          },
        });
        const response = await test.run(language, stream);
        expect(response.confirmation).toEqual(action);
        expect(response.reply).not.toBe(unavailable(language));
        expect(text(test)).toBe(stream ? response.reply : "");
        expect(test.call).toHaveBeenCalledOnce();
      });
      it("preserves warm conversation when please only requests listening", async () => {
        const test = fixture(
          [{ text: "I'm here. Tell me what is on your mind." }],
          { noTools: true },
        );
        const response = await test.run(
          language,
          stream,
          "I'm tired of this weather, please just listen.",
        );
        expect(response.reply).toBe("I'm here. Tell me what is on your mind.");
        expect(response.unavailable).toBeUndefined();
        expect(text(test)).toBe(stream ? response.reply : "");
        expect(test.execute).not.toHaveBeenCalled();
      });
      it.each([
        "Wat kost een fiets van 240 euro?",
        "How much does a 240 euro bike cost?",
      ])("keeps supplied-price context on normal chat: %s", async (message) => {
        const test = fixture(
          [{ text: "The price is already supplied in the question." }],
          { noTools: true },
        );
        const response = await test.run(language, stream, message);
        expect(response.reply).toBe(
          "The price is already supplied in the question.",
        );
        expect(response.unavailable).toBeUndefined();
        expect(test.call).toHaveBeenCalledOnce();
        expect(text(test)).toBe(stream ? response.reply : "");
      });
      it.each(["How much do you know about Python?", "How much is enough?"])(
        "keeps non-price how-much conversation available: %s",
        async (message) => {
          const test = fixture([{ text: "A useful conversational answer." }], {
            noTools: true,
          });
          const response = await test.run(language, stream, message);
          expect(response.reply).toBe("A useful conversational answer.");
          expect(response.unavailable).toBeUndefined();
          expect(test.call).toHaveBeenCalledOnce();
          expect(text(test)).toBe(stream ? response.reply : "");
        },
      );
      it("preserves ordinary conceptual answers without available tools", async () => {
        const test = fixture(
          [{ text: "A simulation can use synthetic temperatures." }],
          { noTools: true },
        );
        const response = await test.run(
          language,
          stream,
          "Explain how weather forecasting works",
        );
        expect(response.reply).toBe(
          "A simulation can use synthetic temperatures.",
        );
        expect(text(test)).toBe(stream ? response.reply : "");
        expect(test.call).toHaveBeenCalledOnce();
      });
      it("preserves attached-document-only answers", async () => {
        const test = fixture([
          { text: "The file describes historical weather." },
        ]);
        const response = await test.run(
          language,
          stream,
          "Vat het nieuws in dit bestand samen",
          true,
        );
        expect(response.reply).toBe("The file describes historical weather.");
        expect(test.execute).not.toHaveBeenCalled();
        expect(text(test)).toBe(stream ? response.reply : "");
      });
      it("does not retry a model call cancelled on its first required attempt", async () => {
        const test = fixture([{ text: invented, abort: true }]);
        await expect(test.run(language, stream)).rejects.toThrow(
          "Request cancelled",
        );
        expect(test.call).toHaveBeenCalledOnce();
        expect(text(test)).toBe("");
      });
      it("rejects cancellation before any exhausted text or fallback", async () => {
        const test = fixture([
          { text: invented },
          { text: invented, abort: true },
        ]);
        await expect(test.run(language, stream)).rejects.toThrow();
        expect(text(test)).toBe("");
        expect(test.events.some(({ event }) => event === "mood")).toBe(false);
      });
    });
  },
);

import { describe, expect, it, vi } from "vitest";
import { OrchestratorService } from "../../src/chat/orchestrator.service.js";
import { TOOL_DISCOVERY_NAME } from "../../src/tools/tool-selection.js";
import type { ToolResult } from "../../src/tools/tool.types.js";

const invented = "It is currently19°C outside; everything was checked.";
const grounded = "The alternate source reports19°C.";
interface Round {
  tools?: string[];
  text?: string;
  abort?: boolean;
}
function fixture(
  rounds: Round[],
  results: Record<string, ToolResult>,
  maxToolRounds = 5,
) {
  const controller = new AbortController();
  const names = ["weather_primary", "weather_backup", TOOL_DISCOVERY_NAME];
  const definitions = names.map((name) => ({
    name,
    function: { name },
    enabled: true,
    risk: "READ_ONLY",
  }));
  let index = 0;
  const call = vi.fn(async (_messages, options) => {
    const round = rounds[index++];
    if (!round) throw new Error("Unexpected extra model call");
    if (round.abort) controller.abort();
    if (options.stream && round.text) {
      options.emit("token", { text: round.text });
      options.emit("mood", { mood: "happy" });
    }
    return {
      assistant: {
        role: "assistant",
        content: round.text ?? "",
        ...(round.tools
          ? {
              tool_calls: round.tools.map((name) => ({
                id: `call-${index}-${name}`,
                type: "function",
                function: {
                  name,
                  arguments: JSON.stringify(
                    name === TOOL_DISCOVERY_NAME ? { query: "weather" } : {},
                  ),
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
  const execute = vi.fn(
    async (name: string) =>
      results[name] ?? { ok: false, error: "private fixture diagnostic" },
  );
  const service = new OrchestratorService(
    { maxToolRounds } as never,
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
    { handle: vi.fn().mockResolvedValue(null) } as never,
    {
      build: async () => [
        { role: "system", content: "Synthetic fixture." },
        { role: "user", content: "Synthetic question." },
      ],
    } as never,
  );
  const events: Array<{ event: string; data: Record<string, unknown> }> = [];
  const run = (
    language: "nl" | "en",
    stream: boolean,
    message = "Hoe warm is het nu buiten?",
  ) =>
    service.run({
      sessionId: "live-evidence-fixture",
      message,
      responseLanguage: language,
      stream,
      signal: controller.signal,
      emit: (event, data) => events.push({ event, data }),
    });
  return { call, execute, run, events };
}
const unavailable = (language: "nl" | "en") =>
  language === "en"
    ? "I could not verify the current information. Please try again later."
    : "Ik kon de actuele gegevens niet controleren. Probeer het straks nog eens.";
const failure = { ok: false, error: "private upstream weather diagnostic" };
const text = (
  events: Array<{ event: string; data: Record<string, unknown> }>,
) =>
  events
    .filter(({ event }) => event === "token")
    .map(({ data }) => data.text)
    .join("");

describe.each(["nl", "en"] as const)(
  "required %s live-read evidence",
  (language) => {
    describe.each([false, true])("stream=%s", (stream) => {
      it.each([
        { result: { ok: true, executed: false } },
        { result: { ok: true, verified: false } },
      ])(
        "respects explicit negative evidence despite ok=true case %#",
        async ({ result }) => {
          const test = fixture(
            [{ tools: ["weather_primary"] }, { text: invented }],
            { weather_primary: result },
          );
          const response = await test.run(language, stream);
          expect(response.reply).toBe(unavailable(language));
          expect(text(test.events)).toBe(stream ? response.reply : "");
          expect(test.events.some(({ event }) => event === "mood")).toBe(false);
        },
      );

      it("accepts a successful ordinary read with unknown verification", async () => {
        const test = fixture(
          [{ tools: ["weather_primary"] }, { text: grounded }],
          {
            weather_primary: {
              ok: true,
              verified: null,
              result: { temperature: 19 },
            },
          },
        );
        const response = await test.run(language, stream);
        expect(response.reply).toBe(grounded);
        expect(text(test.events)).toBe(stream ? grounded : "");
      });

      it("replaces invented current weather after the actual read failed", async () => {
        const test = fixture(
          [{ tools: ["weather_primary"] }, { text: invented }],
          { weather_primary: failure },
        );
        const response = await test.run(language, stream);
        expect(response.reply).toBe(unavailable(language));
        expect(response.model).toBe("fixture");
        expect(text(test.events)).toBe(stream ? response.reply : "");
        expect(test.events.some(({ event }) => event === "mood")).toBe(false);
        expect(response).not.toHaveProperty("mood");
        expect(JSON.stringify({ response, events: test.events })).not.toContain(
          "private upstream",
        );
        expect(JSON.stringify({ response, events: test.events })).not.toContain(
          invented,
        );
        expect(
          test.events.filter(({ event }) => event === "tool_start"),
        ).toHaveLength(1);
        expect(
          test.events.find(({ event }) => event === "tool_result")?.data,
        ).toMatchObject({
          name: "weather_primary",
          ok: false,
          risk: "READ_ONLY",
        });
        expect(test.call).toHaveBeenCalledTimes(2);
      });

      it("allows another read attempt but drops its speculative narration if both sources fail", async () => {
        const test = fixture(
          [
            { tools: ["weather_primary"] },
            { tools: ["weather_backup"], text: invented },
            { text: invented },
          ],
          { weather_primary: failure, weather_backup: failure },
        );
        const response = await test.run(language, stream);
        expect(response.reply).toBe(unavailable(language));
        expect(text(test.events)).toBe(stream ? response.reply : "");
        expect(test.execute).toHaveBeenCalledTimes(2);
        expect(
          test.events.filter(({ event }) => event === "tool_start"),
        ).toHaveLength(2);
        expect(
          test.events
            .filter(({ event }) => event === "tool_result")
            .map(({ data }) => data.ok),
        ).toEqual([false, false]);
        expect(test.events.some(({ event }) => event === "mood")).toBe(false);
      });

      it("restores ordinary narration after an actual alternative read succeeds", async () => {
        const test = fixture(
          [
            { tools: ["weather_primary"] },
            { tools: ["weather_backup"], text: invented },
            { text: grounded },
          ],
          {
            weather_primary: failure,
            weather_backup: { ok: true, result: { temperature: 19 } },
          },
        );
        const response = await test.run(language, stream);
        expect(response.reply).toBe(grounded);
        expect(text(test.events)).toBe(stream ? grounded : "");
        expect(
          test.events
            .filter(({ event }) => event === "tool_result")
            .map(({ data }) => data.ok),
        ).toEqual([false, true]);
        expect(test.call).toHaveBeenCalledTimes(3);
      });

      it("does not count successful discovery metadata as a successful actual live read", async () => {
        const test = fixture(
          [
            { tools: ["weather_primary"] },
            { tools: [TOOL_DISCOVERY_NAME], text: invented },
            { text: invented },
          ],
          {
            weather_primary: failure,
            [TOOL_DISCOVERY_NAME]: { ok: true, result: [] },
          },
        );
        const response = await test.run(language, stream);
        expect(response.reply).toBe(unavailable(language));
        expect(text(test.events)).toBe(stream ? response.reply : "");
        expect(test.execute).toHaveBeenCalledTimes(2);
      });

      it("preserves a context-only answer after an incidental read failure", async () => {
        const conceptual =
          "Blauw licht wordt sterker verstrooid door luchtmoleculen.";
        const test = fixture(
          [{ tools: ["weather_primary"] }, { text: conceptual }],
          { weather_primary: failure },
        );
        const response = await test.run(
          language,
          stream,
          "Leg uit waarom de hemel blauw is.",
        );
        expect(response.reply).toBe(conceptual);
        expect(text(test.events)).toBe(stream ? conceptual : "");
      });

      it("preserves the existing policy when no actual tool is ever attempted", async () => {
        const test = fixture(
          [
            { text: "Existing no-tool reply." },
            { text: "Existing no-tool reply." },
          ],
          {},
        );
        const response = await test.run(language, stream);
        expect(response.reply).toBe("Existing no-tool reply.");
        expect(test.execute).not.toHaveBeenCalled();
      });
    });

    it("does not emit speculative tokens or an unavailable fallback after cancellation", async () => {
      const test = fixture(
        [{ tools: ["weather_primary"] }, { text: invented, abort: true }],
        { weather_primary: failure },
      );
      await expect(test.run(language, true)).rejects.toThrow(
        "Request cancelled",
      );
      expect(text(test.events)).toBe("");
      expect(test.events.some(({ event }) => event === "mood")).toBe(false);
    });

    it("preserves the tool-round limit rather than replacing it with a fabricated final answer", async () => {
      const test = fixture(
        [
          { tools: ["weather_primary"] },
          { tools: ["weather_backup"], text: invented },
        ],
        { weather_primary: failure, weather_backup: failure },
        2,
      );
      await expect(test.run(language, true)).rejects.toThrow(
        "Maximum tool-call rounds reached",
      );
      expect(test.execute).toHaveBeenCalledOnce();
      expect(text(test.events)).toBe("");
    });
  },
);

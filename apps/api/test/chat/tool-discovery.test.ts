import { expect, it, vi } from "vitest";
import { OrchestratorService } from "../../src/chat/orchestrator.service.js";
import { TOOL_DISCOVERY_NAME } from "../../src/tools/tool-selection.js";

it("refreshes discovered tools before the next model request and still requires real live data", async () => {
  const definition = (name: string) => ({
    type: "function" as const,
    function: { name, description: name, parameters: { type: "object" } },
  });
  const discovery = definition(TOOL_DISCOVERY_NAME),
    weather = definition("weather_forecast");
  const call = vi
    .fn()
    .mockImplementationOnce(async (_messages, options) => {
      expect(options.tools).toEqual([discovery]);
      expect(options.toolChoice).toBe("required");
      return {
        assistant: {
          role: "assistant",
          tool_calls: [
            {
              id: "catalog",
              type: "function",
              function: {
                name: TOOL_DISCOVERY_NAME,
                arguments: '{"query":"weather"}',
              },
            },
          ],
        },
      };
    })
    .mockImplementationOnce(async (_messages, options) => {
      expect(options.tools).toEqual([discovery, weather]);
      expect(options.toolChoice).toBe("required");
      return {
        assistant: {
          role: "assistant",
          tool_calls: [
            {
              id: "weather",
              type: "function",
              function: { name: "weather_forecast", arguments: "{}" },
            },
          ],
        },
      };
    })
    .mockResolvedValueOnce({
      assistant: { role: "assistant", content: "Het blijft droog." },
    });
  const tools = {
    list: () => [
      { name: TOOL_DISCOVERY_NAME, enabled: true, risk: "READ_ONLY" },
      { name: "weather_forecast", enabled: true, risk: "READ_ONLY" },
    ],
    forModel: () => [discovery],
    expandModelTools: vi.fn(() => [discovery, weather]),
    execute: vi
      .fn()
      .mockResolvedValue({
        ok: true,
        result: { tools: [{ name: "malicious_forged_schema" }] },
      }),
  };
  const service = new OrchestratorService(
    { maxToolRounds: 4 } as never,
    { call } as never,
    {
      assertFree: () => ({ ready: true }),
      preferredModelForRole: () => undefined,
    } as never,
    tools as never,
    { cancel: vi.fn() } as never,
    { handle: vi.fn().mockResolvedValue(null) } as never,
    {
      build: vi
        .fn()
        .mockResolvedValue([{ role: "user", content: "Check weather" }]),
    } as never,
  );
  const result = await service.run({
    sessionId: "discovery-fixture",
    message: "Check weather",
    readOnlyOnly: true,
  });
  expect(result.reply).toBe("Het blijft droog.");
  expect(tools.expandModelTools).toHaveBeenCalledWith(
    expect.any(Array),
    "weather",
    true,
  );
  expect(tools.execute).toHaveBeenCalledTimes(2);
  expect(tools.execute).toHaveBeenLastCalledWith(
    "weather_forecast",
    {},
    "discovery-fixture",
    null,
    false,
    expect.objectContaining({ readOnlyOnly: true }),
  );
});

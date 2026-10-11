import { describe, expect, it, vi } from "vitest";
import { OrchestratorService } from "../../src/chat/orchestrator.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { RoutingService } from "../../src/routing/routing.service.js";
import type { ToolsService } from "../../src/tools/tools.service.js";
import type { OmniRouteClient } from "../../src/chat/omniroute-client.service.js";
import type { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import type { ConfirmationHandler } from "../../src/chat/confirmation-handler.service.js";
import type { ContextBuilder } from "../../src/chat/context-builder.service.js";

const call = (id: string, name: string) => ({
  id,
  type: "function" as const,
  function: { name, arguments: "{}" },
});

describe("multi-step chat progress", () => {
  it("numbers tool actions across model rounds and emits a final answer", async () => {
    const client = {
      call: vi
        .fn()
        .mockResolvedValueOnce({
          assistant: {
            role: "assistant",
            tool_calls: [call("one", "list_show")],
          },
          model: "fixture",
          usage: null,
        })
        .mockResolvedValueOnce({
          assistant: {
            role: "assistant",
            tool_calls: [call("two", "ha_scene")],
          },
          model: "fixture",
          usage: null,
        })
        .mockResolvedValueOnce({
          assistant: { role: "assistant", content: "Alles staat klaar." },
          model: "fixture",
          usage: null,
        }),
    } as unknown as OmniRouteClient;
    const definitions = ["list_show", "ha_scene"].map((name) => ({
      function: { name },
      enabled: true,
    }));
    const tools = {
      list: () => definitions,
      forModel: () => definitions,
      execute: vi.fn().mockResolvedValue({ ok: true }),
    } as unknown as ToolsService;
    const routing = {
      assertFree: () => ({ ready: true }),
      preferredModelForRole: () => undefined,
    } as unknown as RoutingService;
    const confirmations = {
      cancel: vi.fn(),
    } as unknown as ConfirmationsService;
    const confirmationHandler = {
      handle: vi.fn().mockResolvedValue(null),
    } as unknown as ConfirmationHandler;
    const context = {
      build: vi.fn().mockResolvedValue([
        { role: "system", content: "system" },
        { role: "user", content: "Zet alles klaar voor de film." },
      ]),
    } as unknown as ContextBuilder;
    const service = new OrchestratorService(
      { maxToolRounds: 4 } as NovaConfig,
      client,
      routing,
      tools,
      confirmations,
      confirmationHandler,
      context,
    );
    const events: { event: string; data: Record<string, unknown> }[] = [];

    const reply = await service.run({
      sessionId: "film-night",
      message: "Zet alles klaar voor de film.",
      stream: true,
      emit: (event, data) => events.push({ event, data }),
    });

    expect(reply.reply).toBe("Alles staat klaar.");
    expect(
      events
        .filter(({ event }) => event === "tool_start")
        .map(({ data }) => data.step),
    ).toEqual([1, 2]);
    expect(tools.execute).toHaveBeenCalledTimes(2);
  });
});

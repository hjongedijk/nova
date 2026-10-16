import { describe, expect, it, vi } from "vitest";
import { OrchestratorService } from "../../src/chat/orchestrator.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { RoutingService } from "../../src/routing/routing.service.js";
import type { ToolsService } from "../../src/tools/tools.service.js";
import type { OmniRouteClient } from "../../src/chat/omniroute-client.service.js";
import type { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import type { ConfirmationHandler } from "../../src/chat/confirmation-handler.service.js";
import type { ContextBuilder } from "../../src/chat/context-builder.service.js";

const run = async (message: string, toolResult: Record<string, unknown>) => {
  const client = {
    call: vi
      .fn()
      .mockResolvedValueOnce({
        assistant: {
          role: "assistant",
          tool_calls: [
            {
              id: "one",
              type: "function",
              function: {
                name: "create_visualization",
                arguments: '{"source":"proxmox"}',
              },
            },
          ],
        },
        model: "fixture",
        usage: null,
      })
      .mockResolvedValueOnce({
        assistant: { role: "assistant", content: "Dit is je Proxmox." },
        model: "fixture",
        usage: null,
      }),
  } as unknown as OmniRouteClient;
  const definitions = [
    {
      function: { name: "create_visualization" },
      name: "create_visualization",
      risk: "READ_ONLY",
      enabled: true,
    },
  ];
  const tools = {
    list: () => definitions,
    forModel: () => definitions,
    execute: vi.fn().mockResolvedValue(toolResult),
  } as unknown as ToolsService;
  const service = new OrchestratorService(
    { maxToolRounds: 4 } as NovaConfig,
    client,
    {
      assertFree: () => ({ ready: true }),
      preferredModelForRole: () => undefined,
    } as unknown as RoutingService,
    tools,
    { cancel: vi.fn() } as unknown as ConfirmationsService,
    {
      handle: vi.fn().mockResolvedValue(null),
    } as unknown as ConfirmationHandler,
    {
      build: vi.fn().mockResolvedValue([
        { role: "system", content: "system" },
        { role: "user", content: message },
      ]),
    } as unknown as ContextBuilder,
  );
  const events: { event: string; data: Record<string, unknown> }[] = [];
  await service.run({
    sessionId: "viz",
    message,
    stream: true,
    emit: (event, data) => events.push({ event, data }),
  });
  return events;
};

describe("visualization events in the chat stream", () => {
  it("tells the screen to open the view when a visualization tool succeeded", async () => {
    const events = await run("Toon mijn Proxmox", {
      ok: true,
      verified: true,
      result: { id: "viz-0123456789" },
      visualization: {
        id: "viz-0123456789",
        title: "Proxmox-topologie",
        kind: "graph",
        revision: 1,
        action: "open",
      },
    });
    expect(events.filter((e) => e.event === "visualization")).toEqual([
      {
        event: "visualization",
        data: expect.objectContaining({ id: "viz-0123456789", action: "open" }),
      },
    ]);
  });

  it("opens nothing for a failed tool or a result without a visualization", async () => {
    const failed = await run("Toon mijn Proxmox", {
      ok: false,
      error: "Proxmox is niet gekoppeld",
      visualization: { id: "viz-0123456789" },
    });
    expect(failed.some((e) => e.event === "visualization")).toBe(false);
    const plain = await run("Welke VM's draaien er?", { ok: true });
    expect(plain.some((e) => e.event === "visualization")).toBe(false);
  });
});

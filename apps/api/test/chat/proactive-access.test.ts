import { UnauthorizedException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ChatController } from "../../src/chat/chat.controller.js";
import type { ConfirmationHandler } from "../../src/chat/confirmation-handler.service.js";
import type { OrchestratorService } from "../../src/chat/orchestrator.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import type { MqttService } from "../../src/core/mqtt/mqtt.service.js";
import type { SessionMemoryService } from "../../src/memory/session-memory.service.js";
import type { OmniRouteClient } from "../../src/chat/omniroute-client.service.js";

const token = "node-red-proactive-token-for-test-only-123456";
const run = vi.fn();

function controller(): ChatController {
  return new ChatController(
    { run } as unknown as OrchestratorService,
    {} as ConfirmationHandler,
    {} as SessionMemoryService,
    { configured: true } as OmniRouteClient,
    {} as MqttService,
    { nodeRedEventToken: token } as NovaConfig,
  );
}

afterEach(() => run.mockReset());

describe("Node-RED proactive chat boundary", () => {
  it("rejects missing or incorrect bearer tokens", async () => {
    const chat = controller();
    await expect(
      chat.proactiveAsk(undefined, { message: "status" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      chat.proactiveAsk("Bearer wrong-token", { message: "status" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(run).not.toHaveBeenCalled();
  });

  it("rejects attachments on automated requests", async () => {
    const chat = controller();
    await expect(
      chat.proactiveAsk(`Bearer ${token}`, {
        message: "Read this",
        attachments: [
          {
            name: "note.txt",
            mimeType: "text/plain",
            content: "note content",
          },
        ],
      }),
    ).rejects.toThrow("Proactive requests cannot include attachments");
    expect(run).not.toHaveBeenCalled();
  });
});

import { UnauthorizedException } from "@nestjs/common";
import { afterEach, describe, expect, it, vi } from "vitest";
import { APP_ACCESS_PUBLIC } from "../../src/access/access-public.js";
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
  it("is public to app auth but rejects missing or incorrect bearer tokens", async () => {
    expect(
      Reflect.getMetadata(
        APP_ACCESS_PUBLIC,
        ChatController.prototype.proactiveAsk,
      ),
    ).toBe(true);
    const chat = controller();
    await expect(
      chat.proactiveAsk(undefined, { message: "status" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    await expect(
      chat.proactiveAsk("Bearer wrong-token", { message: "status" }),
    ).rejects.toBeInstanceOf(UnauthorizedException);
    expect(run).not.toHaveBeenCalled();
  });

  it("uses a fresh session and asks the orchestrator for read-only tools", async () => {
    run.mockResolvedValue({ reply: "Alles rustig", model: null, usage: null });
    const response = await controller().proactiveAsk(`Bearer ${token}`, {
      message: "Geef een korte briefing",
      sessionId: "a-user-session-that-must-not-be-used",
      responseLanguage: "nl",
      modelRole: "summary",
    });
    expect(run).toHaveBeenCalledWith(
      expect.objectContaining({
        message: "Geef een korte briefing",
        responseLanguage: "nl",
        modelRole: "summary",
        readOnlyOnly: true,
        sessionId: expect.stringMatching(/^proactive_/),
      }),
    );
    expect(response).toMatchObject({ reply: "Alles rustig" });
    expect(response.sessionId).not.toBe("a-user-session-that-must-not-be-used");
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

import { describe, expect, it, vi } from "vitest";
import { ConfirmationHandler } from "../../src/chat/confirmation-handler.service.js";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import type { AuditService } from "../../src/core/audit/audit.service.js";
import type { SessionMemoryService } from "../../src/memory/session-memory.service.js";
import type { ToolsService } from "../../src/tools/tools.service.js";
import type { OutcomeService } from "../../src/chat/outcome.service.js";

describe("confirmations without a screen-only gate", () => {
  it("runs a sensitive action on a spoken yes, like the button", async () => {
    const audit = { record: vi.fn() };
    const confirmations = new ConfirmationsService(
      audit as unknown as AuditService,
    );
    const execute = vi.fn(async () => ({ ok: true, verified: true }));
    const handler = new ConfirmationHandler(
      confirmations,
      { execute } as unknown as ToolsService,
      audit as unknown as AuditService,
      { recent: () => [] } as unknown as SessionMemoryService,
      { describe: vi.fn() } as unknown as OutcomeService,
    );
    const action = confirmations.create(
      "chat",
      "ha_call_service",
      { domain: "alarm_control_panel", service: "alarm_arm_home" },
      "DANGEROUS",
    );
    const spoken = await handler.handle("chat", "ja", action.confirmationId);
    expect(spoken?.reply).not.toMatch(/knop op het scherm/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(confirmations.has("chat")).toBe(false);
    expect(
      await handler.handle("chat", "ja", action.confirmationId),
    ).toMatchObject({
      reply: expect.stringMatching(/niets meer/),
    });
  });

  it("still accepts spoken cancellation and ordinary confirmations", async () => {
    const audit = { record: vi.fn() };
    const confirmations = new ConfirmationsService(
      audit as unknown as AuditService,
    );
    const execute = vi.fn(async () => ({ ok: true }));
    const handler = new ConfirmationHandler(
      confirmations,
      { execute } as unknown as ToolsService,
      audit as unknown as AuditService,
      { recent: () => [] } as unknown as SessionMemoryService,
      { describe: vi.fn() } as unknown as OutcomeService,
    );
    confirmations.create(
      "chat",
      "browser_click_confirmed",
      { id: 3 },
      "CONFIRM",
    );
    expect((await handler.handle("chat", "nee"))?.reply).toMatch(
      /laat het zitten/,
    );
    expect(execute).not.toHaveBeenCalled();
    const ordinary = confirmations.create(
      "chat",
      "timer_cancel",
      { id: "timer-1" },
      "CONFIRM",
    );
    expect(
      (await handler.handle("chat", "ja", ordinary.confirmationId))?.reply,
    ).toMatch(/Is gedaan/);
    expect(execute).toHaveBeenCalledTimes(1);
  });
});

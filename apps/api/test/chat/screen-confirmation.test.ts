import { describe, expect, it, vi } from "vitest";
import { ConfirmationHandler } from "../../src/chat/confirmation-handler.service.js";
import { requiresScreenConfirmation } from "../../src/confirmations/screen-confirmation.js";
import { ConfirmationsService } from "../../src/confirmations/confirmations.service.js";
import type { AuditService } from "../../src/core/audit/audit.service.js";
import type { SessionMemoryService } from "../../src/memory/session-memory.service.js";
import type { ToolsService } from "../../src/tools/tools.service.js";
import type { OutcomeService } from "../../src/chat/outcome.service.js";

describe("on-screen confirmation for sensitive actions", () => {
  it("classifies doors, alarms, purchases and dangerous actions", () => {
    expect(
      requiresScreenConfirmation(
        "ha_call_service",
        { domain: "lock" },
        "CONFIRM",
      ),
    ).toBe(true);
    expect(
      requiresScreenConfirmation(
        "ha_call_service",
        { domain: "alarm_control_panel" },
        "CONFIRM",
      ),
    ).toBe(true);
    expect(
      requiresScreenConfirmation(
        "ha_call_service",
        { domain: "cover", service: "open_cover" },
        "CONFIRM",
      ),
    ).toBe(true);
    expect(
      requiresScreenConfirmation(
        "ha_call_service",
        { domain: "scene", service: "turn_on" },
        "CONFIRM",
      ),
    ).toBe(true);
    expect(
      requiresScreenConfirmation("browser_click_confirmed", {}, "CONFIRM"),
    ).toBe(true);
    expect(
      requiresScreenConfirmation("code_file_delete", {}, "DANGEROUS"),
    ).toBe(true);
    expect(
      requiresScreenConfirmation(
        "ha_call_service",
        { domain: "light" },
        "CONFIRM",
      ),
    ).toBe(false);
  });

  it("keeps sensitive actions pending after chat yes, then accepts the button once", async () => {
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
      "CONFIRM",
    );
    const spoken = await handler.handle("chat", "ja", action.confirmationId);
    expect(spoken?.reply).toMatch(/knop op het scherm/);
    expect(execute).not.toHaveBeenCalled();
    expect(confirmations.peek("chat")?.confirmationId).toBe(
      action.confirmationId,
    );
    const pressed = await handler.handle(
      "chat",
      "ja",
      action.confirmationId,
      false,
      "nl",
      true,
    );
    expect(pressed?.reply).toMatch(/Gelukt/);
    expect(execute).toHaveBeenCalledTimes(1);
    expect(confirmations.has("chat")).toBe(false);
    expect(
      await handler.handle(
        "chat",
        "ja",
        action.confirmationId,
        false,
        "nl",
        true,
      ),
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

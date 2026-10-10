import { describe, expect, it, vi } from "vitest";
import type { AuditService } from "../../src/core/audit/audit.service.js";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { ServiceRestart } from "../../src/settings/services/service-restart.service.js";

function fixture({ enabled = true, pending = true } = {}) {
  const record = vi.fn();
  const scheduleRestart = vi.fn();
  const service = new ServiceRestart(
    { restartEnabled: enabled } as NovaConfig,
    { record } as unknown as AuditService,
    {
      list: () => [{ restartRequired: pending }],
    } as never,
  );
  service.scheduleRestart = scheduleRestart;
  return { service, record, scheduleRestart };
}

describe("controlled service restart", () => {
  it("is unavailable unless the process supervisor is explicitly enabled", () => {
    const { service, scheduleRestart } = fixture({ enabled: false });
    expect(service.status()).toMatchObject({
      available: false,
      pendingChanges: true,
      restartPending: false,
    });
    expect(service.request()).toMatchObject({ ok: false });
    expect(scheduleRestart).not.toHaveBeenCalled();
  });

  it("requires pending changes and schedules one audited graceful restart", () => {
    const noChanges = fixture({ pending: false });
    expect(noChanges.service.request()).toMatchObject({ ok: false });
    expect(noChanges.scheduleRestart).not.toHaveBeenCalled();

    const f = fixture();
    expect(f.service.request()).toEqual({ ok: true, scheduled: true });
    expect(f.service.status().restartPending).toBe(true);
    expect(f.service.request()).toMatchObject({ ok: false });
    expect(f.scheduleRestart).toHaveBeenCalledTimes(1);
    expect(f.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "settings_service_restart",
        phase: "before_execute",
        arguments: { pendingChanges: true },
      }),
    );
  });
});

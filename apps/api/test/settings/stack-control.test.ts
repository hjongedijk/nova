import { beforeEach, describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { StackControlService } from "../../src/settings/stack-control.service.js";

const token = "a".repeat(64);
const revision = "b".repeat(64);
const services = [
  ["nova", "NOVA"],
  ["node-red", "Node-RED"],
  ["omniroute", "OmniRoute"],
  ["mqtt", "MQTT"],
  ["qdrant", "Qdrant"],
  ["home-assistant", "Home Assistant"],
  ["stack-control", "Stackbeheer"],
].map(([id]) => ({
  id,
  label: "untrusted broker label",
  state: "running",
  health: "healthy",
  revision,
  startedAt: "2026-10-11T10:00:00Z",
}));

describe("StackControlService", () => {
  let audit: { record: ReturnType<typeof vi.fn> };
  let confirmations: {
    create: ReturnType<typeof vi.fn>;
    peek: ReturnType<typeof vi.fn>;
    take: ReturnType<typeof vi.fn>;
  };
  let pending: Record<string, unknown> | null;
  let service: StackControlService;

  beforeEach(() => {
    audit = { record: vi.fn() };
    pending = null;
    confirmations = {
      create: vi.fn((sessionId, tool, args, risk, schemaFingerprint) => {
        pending = {
          sessionId,
          tool,
          args,
          risk,
          schemaFingerprint,
          confirmationId: "c".repeat(36),
        };
        return pending;
      }),
      peek: vi.fn(() => pending),
      take: vi.fn(() => {
        const value = pending;
        pending = null;
        return value;
      }),
    };
    service = new StackControlService(
      {
        stackControlUrl: "http://stack-control:8090",
        stackControlToken: token,
      } as NovaConfig,
      confirmations as never,
      audit as never,
    );
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => Response.json({ services })),
    );
  });

  it("returns only fixed service names and fails closed on an incomplete report", async () => {
    const status = await service.status();
    expect(status.available).toBe(true);
    expect(status.services[0]).toMatchObject({ id: "nova", label: "NOVA" });
    expect(status.services[0]?.startedAt).toBe("2026-10-11T10:00:00Z");
    expect(
      status.services.find((row) => row.id === "stack-control")?.canRestart,
    ).toBe(false);
    expect(JSON.stringify(status)).not.toContain("untrusted broker label");
    vi.mocked(fetch).mockResolvedValueOnce(Response.json({ services: [] }));
    expect(await service.status()).toMatchObject({
      available: false,
      services: [],
    });
  });

  it("prepares a one-time DANGEROUS action and executes only after approval", async () => {
    const prepared = await service.prepareRestart("qdrant");
    expect(prepared).toMatchObject({
      ok: true,
      service: "qdrant",
      label: "Qdrant",
    });
    expect(confirmations.create).toHaveBeenCalledWith(
      expect.stringMatching(/^settings-stack-restart:/),
      "settings_stack_service_restart",
      { service: "qdrant", revision },
      "DANGEROUS",
      revision,
      false,
    );
    const response = await service.confirmRestart(
      String(pending?.sessionId),
      "c".repeat(36),
      true,
    );
    expect(response).toEqual({ ok: true, service: "qdrant" });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(fetch).toHaveBeenCalledWith(
      "http://stack-control:8090/services/qdrant/restart",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({ expectedRevision: revision }),
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "settings_stack_service_restart",
        risk: "DANGEROUS",
        phase: "after_execute",
        result: { ok: true, service: "qdrant" },
      }),
    );
  });

  it("does not call the broker when the user declines confirmation", async () => {
    await service.prepareRestart("mqtt");
    const response = await service.confirmRestart(
      String(pending?.sessionId),
      "c".repeat(36),
      false,
    );
    expect(response).toMatchObject({
      ok: false,
      error: "Herstart geannuleerd.",
    });
    expect(fetch).toHaveBeenCalledTimes(1); // the read-only prepare status only
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({ confirmation: "rejected_admin_ui" }),
    );
  });

  it("refuses unknown service IDs before reading or writing the broker", async () => {
    await expect(service.prepareRestart("docker" as never)).rejects.toThrow();
    await expect(service.prepareRestart("stack-control")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a stale broker conflict and audits that no restart ran", async () => {
    await service.prepareRestart("mqtt");
    vi.mocked(fetch).mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "service state changed" }), {
        status: 409,
      }),
    );
    const response = await service.confirmRestart(
      String(pending?.sessionId),
      "c".repeat(36),
      true,
    );
    expect(response.ok).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "after_execute",
        result: { ok: false, service: "mqtt" },
      }),
    );
  });
});

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
  ["piper", "Lokale stem"],
  ["home-assistant", "Home Assistant"],
  ["mcp-egress", "MCP-bronverbinding"],
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
  let service: StackControlService;

  beforeEach(() => {
    audit = { record: vi.fn() };
    service = new StackControlService(
      {
        stackControlUrl: "http://stack-control:8090",
        stackControlToken: token,
      } as NovaConfig,
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

  it("shows an absent optional voice service and restarts it only when running", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        services: services.map((row) =>
          row.id === "piper" ? { ...row, state: "missing", health: null } : row,
        ),
      }),
    );
    const status = await service.status();
    expect(status.available).toBe(true);
    expect(status.services.find((row) => row.id === "piper")).toMatchObject({
      label: "Lokale stem",
      state: "missing",
    });
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        services: services.map((row) =>
          row.id === "piper" ? { ...row, state: "missing", health: null } : row,
        ),
      }),
    );
    expect(await service.restart("piper")).toMatchObject({ ok: false });
    expect(fetch).toHaveBeenCalledTimes(2); // two read-only status calls, no restart
  });

  it("projects validated MCP worker counts without Docker secrets", async () => {
    vi.mocked(fetch).mockResolvedValueOnce(
      Response.json({
        services,
        mcpWorkers: [
          {
            server: "filesystem",
            state: "running",
            workerCount: 1,
            Env: ["PRIVATE_TOKEN=secret"],
          },
          { server: ["context7"], state: ["running"], workerCount: 1 },
          { server: "other", state: "running", workerCount: 1 },
          { server: "context7", state: "running", workerCount: -1 },
        ],
      }),
    );
    const status = await service.status();
    expect(status.mcpWorkers).toEqual([
      { server: "filesystem", state: "running", workerCount: 1 },
    ]);
    expect(JSON.stringify(status)).not.toContain("PRIVATE_TOKEN");
  });

  it("restarts a running service in one step and audits the outcome", async () => {
    const response = await service.restart("qdrant");
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

  it("refuses unknown service IDs before reading or writing the broker", async () => {
    await expect(service.restart("docker" as never)).rejects.toThrow();
    await expect(service.restart("stack-control")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });

  it("reports a stale broker conflict and audits that no restart ran", async () => {
    vi.mocked(fetch)
      .mockResolvedValueOnce(Response.json({ services }))
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ error: "service state changed" }), {
          status: 409,
        }),
      );
    const response = await service.restart("mqtt");
    expect(response.ok).toBe(false);
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        phase: "after_execute",
        result: { ok: false, service: "mqtt" },
      }),
    );
  });
});

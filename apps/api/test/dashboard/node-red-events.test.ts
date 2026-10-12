import { describe, expect, it, vi } from "vitest";
import type { NovaConfig } from "../../src/core/config/nova-config.js";
import { NodeRedEventsController } from "../../src/dashboard/node-red-events.controller.js";

const token = "a".repeat(64);

function fixture(configToken = token) {
  const alerts = { recordNodeRedAlert: vi.fn(() => ({ seq: 1 })) };
  const health = { recordRuntimeError: vi.fn() };
  const audit = { record: vi.fn() };
  const controller = new NodeRedEventsController(
    { nodeRedEventToken: configToken } as NovaConfig,
    alerts as never,
    health as never,
    audit as never,
  );
  return { controller, alerts, health, audit };
}

describe("Node-RED event ingress", () => {
  it("requires a configured bearer token and rejects unsupported event types", () => {
    const { controller } = fixture("short");
    expect(() =>
      controller.receive(`Bearer ${token}`, { type: "alert" }),
    ).toThrow("Node-RED event ingress is not configured");
    const enabled = fixture();
    expect(() =>
      enabled.controller.receive(`Bearer ${token}`, { type: "invoke_tool" }),
    ).toThrow("Unsupported Node-RED event type");
    expect(enabled.audit.record).not.toHaveBeenCalled();
  });

  it("accepts bounded plain alerts and records only metadata in the audit", () => {
    const { controller, alerts, audit } = fixture();
    expect(
      controller.receive(`Bearer ${token}`, {
        type: "alert",
        title: "Garage door open",
        detail: "Check the side entrance",
        severity: "warning",
      }),
    ).toEqual({ accepted: true });
    expect(alerts.recordNodeRedAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        title: "Garage door open",
        detail: "Check the side entrance",
        severity: "warning",
      }),
    );
    expect(audit.record).toHaveBeenCalledWith(
      expect.objectContaining({
        tool: "node_red_event",
        phase: "accepted",
        eventType: "alert",
      }),
    );
    expect(JSON.stringify(audit.record.mock.calls)).not.toContain(
      "Garage door",
    );
  });

  it("passes an explicit briefing category to the speech policy", () => {
    const { controller, alerts } = fixture();
    controller.receive(`Bearer ${token}`, {
      type: "alert",
      title: "Ochtendbriefing",
      detail: "Het weer is helder.",
      severity: "info",
      category: "briefing",
    });
    expect(alerts.recordNodeRedAlert).toHaveBeenCalledWith(
      expect.objectContaining({ category: "briefing" }),
    );
    expect(() =>
      controller.receive(`Bearer ${token}`, {
        type: "alert",
        title: "Onbekend",
        category: "other",
      }),
    ).toThrow("Unsupported alert category");
  });

  it("surfaces runtime errors through health without executing an action", () => {
    const { controller, health, alerts } = fixture();
    controller.receive(`Bearer ${token}`, {
      type: "runtime_error",
      detail: "Flow kitchen failed",
    });
    expect(health.recordRuntimeError).toHaveBeenCalledWith(
      "Flow kitchen failed",
      undefined,
    );
    expect(alerts.recordNodeRedAlert).not.toHaveBeenCalled();
  });

  it("keeps a validated flow id for a direct settings link", () => {
    const { controller, health } = fixture();
    controller.receive(`Bearer ${token}`, {
      type: "runtime_error",
      detail: "Kitchen flow failed",
      flowId: "tab.kitchen-1",
    });
    expect(health.recordRuntimeError).toHaveBeenCalledWith(
      "Kitchen flow failed",
      "tab.kitchen-1",
    );
    expect(() =>
      controller.receive(`Bearer ${token}`, {
        type: "runtime_error",
        detail: "Flow failed",
        flowId: "../../other-host",
      }),
    ).toThrow("Invalid Node-RED flow id");
  });

  it("rejects invalid severity and oversized payloads", () => {
    const { controller } = fixture();
    expect(() =>
      controller.receive(`Bearer ${token}`, {
        type: "alert",
        title: "Test",
        severity: "urgent",
      }),
    ).toThrow("Unsupported alert severity");
    expect(() =>
      controller.receive(`Bearer ${token}`, {
        type: "alert",
        title: "x".repeat(5000),
      }),
    ).toThrow("Node-RED event is too large");
  });
});

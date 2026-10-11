import { describe, expect, it } from "vitest";
import { parseTargets } from "../../src/checks/probe.js";
import {
  containerChanges,
  certificateDaysRemaining,
  highPowerEvents,
  powerSensors,
  trackerChanges,
  trackerInventory,
} from "../../src/checks/checks.service.js";

describe("default healthcheck targets", () => {
  it("matches the production Compose service names", () => {
    expect(parseTargets("")).toEqual({
      nova: "http://nova:8080/api/health",
      omniroute: "http://omniroute:20128/",
      mqtt: "tcp://mqtt:1883",
      "node-red": "http://node-red:1880/",
      qdrant: "http://qdrant:6333/",
      internet: "https://1.1.1.1/",
      dns: "dns://cloudflare.com",
    });
  });

  it("uses explicitly configured targets instead of the defaults", () => {
    expect(parseTargets("nas=tcp://192.0.2.5:445")).toEqual({
      internet: "https://1.1.1.1/",
      dns: "dns://cloudflare.com",
      nas: "tcp://192.0.2.5:445",
    });
  });
});

describe("Home Assistant device tracker inventory", () => {
  it("tracks only tracker entity IDs and bounded display names", () => {
    expect(
      trackerInventory([
        {
          entity_id: "device_tracker.phone",
          domain: "device_tracker",
          friendly_name: "Mijn telefoon",
        },
        {
          entity_id: "person.alex",
          domain: "person",
          friendly_name: "Alex",
        },
      ] as never),
    ).toEqual({ "device_tracker.phone": "Mijn telefoon" });
  });

  it("reports additions and removals without treating inventory initialization as a change", () => {
    expect(trackerChanges({}, { "device_tracker.new": "Nieuw" })).toEqual({
      added: [["device_tracker.new", "Nieuw"]],
      removed: [],
    });
    expect(
      trackerChanges(
        { "device_tracker.old": "Oud" },
        { "device_tracker.new": "Nieuw" },
      ),
    ).toEqual({
      added: [["device_tracker.new", "Nieuw"]],
      removed: [["device_tracker.old", "Oud"]],
    });
  });
});

describe("Compose container monitoring", () => {
  it("detects down, recovered and restarted states without treating a baseline as an event", () => {
    const status = [
      {
        id: "nova",
        label: "NOVA",
        state: "running",
        health: "healthy",
        canRestart: true,
        revision: "a".repeat(64),
        startedAt: "2026-10-11T10:00:00Z",
      },
    ] as const;
    expect(containerChanges({}, [...status] as never)).toEqual([]);
    expect(
      containerChanges(
        { nova: { state: "running", startedAt: "2026-10-11T10:00:00Z" } },
        [{ ...status[0], state: "exited" }] as never,
      ).map(({ kind }) => kind),
    ).toEqual(["stopped"]);
    expect(
      containerChanges(
        { nova: { state: "exited", startedAt: "2026-10-11T10:00:00Z" } },
        [...status] as never,
      ).map(({ kind }) => kind),
    ).toEqual(["recovered"]);
    expect(
      containerChanges(
        { nova: { state: "running", startedAt: "2026-10-11T09:00:00Z" } },
        [...status] as never,
      ).map(({ kind }) => kind),
    ).toEqual(["restarted"]);
  });
});

describe("Home Assistant power monitoring", () => {
  it("reads only power sensors in known units and waits for a stable baseline", () => {
    const sensors = powerSensors([
      {
        entity_id: "sensor.meter_power",
        domain: "sensor",
        friendly_name: "Slimme meter",
        state: "2",
        attributes: { device_class: "power", unit_of_measurement: "kW" },
      },
      {
        entity_id: "sensor.daily_energy",
        domain: "sensor",
        state: "9",
        attributes: { device_class: "energy", unit_of_measurement: "kWh" },
      },
    ] as never);
    expect(sensors).toEqual([
      { id: "sensor.meter_power", name: "Slimme meter", watts: 2000 },
    ]);
    const now = 100 * 60_000;
    const baseline = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        index,
        { at: now - (25 - index * 5) * 60_000, watts: 500 },
      ]),
    );
    const result = highPowerEvents(
      [{ id: "sensor.meter_power", name: "Slimme meter", watts: 2000 }],
      { "sensor.meter_power": { samples: Object.values(baseline) } },
      now,
    );
    expect(result.events).toEqual([
      {
        id: "sensor.meter_power",
        name: "Slimme meter",
        watts: 2000,
        average: 500,
      },
    ]);
    expect(
      highPowerEvents(
        [{ id: "sensor.meter_power", name: "Slimme meter", watts: 2000 }],
        result.next,
        now + 5 * 60_000,
      ).events,
    ).toEqual([]);
  });
});

describe("TLS certificate expiry", () => {
  it("calculates days remaining and rejects invalid certificate dates", () => {
    const now = Date.parse("2026-10-11T00:00:00Z");
    expect(certificateDaysRemaining("Oct 21 00:00:00 2026 GMT", now)).toBe(10);
    expect(certificateDaysRemaining("Oct 10 00:00:00 2026 GMT", now)).toBe(-1);
    expect(certificateDaysRemaining("invalid", now)).toBeNull();
  });
});

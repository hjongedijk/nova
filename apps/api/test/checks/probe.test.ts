import { describe, expect, it } from "vitest";
import { parseTargets } from "../../src/checks/probe.js";
import {
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

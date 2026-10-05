import { describe, expect, it } from "vitest";
import { actionRisk } from "../../src/home/risk.js";

describe("actionRisk", () => {
  it("unlock is DANGEROUS, lock and the other sensitive domains need confirmation", () => {
    expect(actionRisk("lock", "unlock")).toBe("DANGEROUS");
    for (const [domain, service] of [
      ["lock", "lock"],
      ["cover", "open_cover"],
      ["cover", "close_cover"],
      ["scene", "turn_on"],
      ["script", "turn_on"],
      ["sonos", "anything"],
    ] as const)
      expect(actionRisk(domain, service)).toBe("CONFIRM");
  });

  it("toggle, announcements and grouping need confirmation in any domain", () => {
    expect(actionRisk("light", "toggle")).toBe("CONFIRM");
    expect(actionRisk("switch", "toggle")).toBe("CONFIRM");
    expect(actionRisk("media_player", "play_media", { announce: true })).toBe(
      "CONFIRM",
    );
    expect(actionRisk("media_player", "play_media", {})).toBe("SAFE");
    expect(actionRisk("media_player", "join")).toBe("CONFIRM");
    expect(actionRisk("media_player", "unjoin")).toBe("CONFIRM");
  });

  it("switches that look like servers, networking or heating are DANGEROUS", () => {
    for (const entity of [
      { entity_id: "switch.proxmox_host", friendly_name: "x" },
      { entity_id: "switch.a", friendly_name: "Router woonkamer" },
      { entity_id: "switch.b", friendly_name: "NAS" },
      { entity_id: "switch.c", friendly_name: "Vijverpomp" },
      { entity_id: "switch.d", friendly_name: "Heater" },
      { entity_id: "switch.e", friendly_name: "Boiler" },
      { entity_id: "switch.f", friendly_name: "Verwarming zolder" },
      { entity_id: "switch.g", friendly_name: "Stopcontact 3" },
      {
        entity_id: "switch.h",
        friendly_name: "x",
        attributes: { device_class: "outlet" },
      },
    ])
      expect(actionRisk("switch", "turn_off", {}, entity)).toBe("DANGEROUS");
    expect(
      actionRisk(
        "switch",
        "turn_on",
        {},
        { entity_id: "switch.lamp", friendly_name: "Lamp" },
      ),
    ).toBe("SAFE");
    // The server check only applies to switches.
    expect(
      actionRisk("light", "turn_off", {}, { friendly_name: "Server lamp" }),
    ).toBe("SAFE");
  });

  it("climate: small plausible changes are SAFE, everything else needs confirmation", () => {
    const entity = { attributes: { temperature: 20 } };
    expect(
      actionRisk("climate", "set_temperature", { temperature: 21 }, entity),
    ).toBe("SAFE");
    expect(
      actionRisk("climate", "set_temperature", { temperature: 22 }, entity),
    ).toBe("SAFE");
    expect(
      actionRisk("climate", "set_temperature", { temperature: 22.5 }, entity),
    ).toBe("CONFIRM");
    expect(
      actionRisk(
        "climate",
        "set_temperature",
        { temperature: 30 },
        { attributes: { temperature: 29 } },
      ),
    ).toBe("CONFIRM");
    expect(
      actionRisk(
        "climate",
        "set_temperature",
        { temperature: 15 },
        { attributes: { temperature: 16 } },
      ),
    ).toBe("CONFIRM");
    expect(
      actionRisk(
        "climate",
        "set_temperature",
        { temperature: 26 },
        { attributes: { temperature: 25 } },
      ),
    ).toBe("SAFE");
    expect(
      actionRisk(
        "climate",
        "set_temperature",
        { temperature: 27 },
        { attributes: { temperature: 26 } },
      ),
    ).toBe("CONFIRM");
    expect(
      actionRisk("climate", "set_temperature", { temperature: 21 }, {}),
    ).toBe("CONFIRM");
    expect(
      actionRisk("climate", "set_temperature", { temperature: "21" }, entity),
    ).toBe("CONFIRM");
    expect(actionRisk("climate", "set_temperature", {}, entity)).toBe(
      "CONFIRM",
    );
  });

  it("volume: quiet, small steps are SAFE; loud, big or malformed ones need confirmation", () => {
    const entity = { attributes: { volume_level: 0.2 } };
    expect(
      actionRisk("media_player", "volume_set", { volume_level: 0.3 }, entity),
    ).toBe("SAFE");
    expect(
      actionRisk("media_player", "volume_set", { volume_level: 0.4 }, entity),
    ).toBe("SAFE");
    expect(
      actionRisk("media_player", "volume_set", { volume_level: 0.45 }, entity),
    ).toBe("CONFIRM");
    expect(
      actionRisk("media_player", "volume_set", { volume_level: 0.9 }, entity),
    ).toBe("CONFIRM");
    expect(
      actionRisk(
        "media_player",
        "volume_set",
        { volume_level: 0.6 },
        { attributes: { volume_level: 0.55 } },
      ),
    ).toBe("CONFIRM");
    expect(
      actionRisk("media_player", "volume_set", { volume_level: "0.3" }, entity),
    ).toBe("CONFIRM");
    expect(actionRisk("media_player", "volume_set", {}, entity)).toBe(
      "CONFIRM",
    );
    // No known current volume counts as 0.
    expect(
      actionRisk("media_player", "volume_set", { volume_level: 0.1 }),
    ).toBe("SAFE");
    expect(
      actionRisk("media_player", "volume_set", { volume_level: 0.3 }),
    ).toBe("CONFIRM");
  });

  it("plain lights, fans and media controls are SAFE", () => {
    expect(actionRisk("light", "turn_on", { brightness_pct: 30 })).toBe("SAFE");
    expect(actionRisk("fan", "turn_off")).toBe("SAFE");
    expect(actionRisk("media_player", "media_pause")).toBe("SAFE");
    expect(
      actionRisk("media_player", "volume_mute", { is_volume_muted: true }),
    ).toBe("SAFE");
  });
});

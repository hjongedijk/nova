/** Synthetic persona fixtures only. Importing this module performs no I/O or model calls. */
export function toolsFor(id) {
  const definitions = {
    system_time: ["Current local time fixture; read-only."],
    weather_forecast: [
      "Current weather fixture. Empty location means the configured home; this test has no home location.",
      {
        location: { type: "string" },
        days: { type: "integer", minimum: 1, maximum: 7 },
      },
    ],
    home_status: ["Read-only fixture of actual home devices."],
    ha_search_entities: [
      "Find matching actual home entities in the fixture.",
      { query: { type: "string" } },
      ["query"],
    ],
    ha_get_state: [
      "Read a current entity state from the fixture.",
      { entity_id: { type: "string" } },
      ["entity_id"],
    ],
    proxmox_status: ["Read-only Proxmox host status fixture."],
    proxmox_guests: ["Read-only virtual machine inventory fixture."],
    proxmox_reboot_guest: [
      "Request a restart of one VM. This harness never executes it; the result only says confirmation is required.",
      { vmid: { type: "integer", minimum: 1 } },
      ["vmid"],
    ],
    ha_turn_off: [
      "Request turning off one actual home device. This harness never executes it; the result only says confirmation is required.",
      { entity_id: { type: "string" } },
      ["entity_id"],
    ],
  };
  const byCase = {
    P19: ["system_time"],
    P20: ["weather_forecast"],
    P21: ["home_status", "ha_search_entities", "ha_get_state"],
    P22: ["proxmox_guests"],
    P23: ["proxmox_status", "proxmox_guests", "proxmox_reboot_guest"],
    P24: ["home_status", "ha_search_entities", "ha_turn_off"],
  };
  return (byCase[id] ?? []).map((name) => {
    const [description, properties = {}, required = []] = definitions[name];
    return {
      type: "function",
      function: {
        name,
        description,
        parameters: {
          type: "object",
          properties,
          required,
          additionalProperties: false,
        },
      },
    };
  });
}

export function mockTool(name, args) {
  switch (name) {
    case "system_time":
      return {
        ok: true,
        result: {
          local: {
            spoken: "kwart over tien",
            time: "10:15",
            timezone: "Europe/Amsterdam",
          },
        },
      };
    case "weather_forecast":
      return {
        ok: false,
        error: args.location
          ? "Geen weerfixture voor deze locatie."
          : "Thuislocatie niet ingesteld; vraag de gebruiker om een plaats.",
      };
    case "home_status":
      return {
        ok: true,
        result: {
          devices: [
            {
              entity_id: "light.woonkamer",
              name: "Woonkamerlamp",
              state: "on",
            },
            { entity_id: "light.gang", name: "Ganglamp", state: "on" },
            { entity_id: "light.keuken", name: "Keukenlamp", state: "on" },
          ],
        },
      };
    case "ha_search_entities":
      return {
        ok: true,
        result: [
          {
            entity_id: "light.woonkamer",
            name: "Woonkamerlamp",
            area: "Woonkamer",
          },
          { entity_id: "light.gang", name: "Ganglamp", area: "Gang" },
          { entity_id: "light.keuken", name: "Keukenlamp", area: "Keuken" },
        ],
      };
    case "ha_get_state":
      return {
        ok: args.entity_id === "light.woonkamer",
        result: { entity_id: args.entity_id, state: "on" },
        error:
          args.entity_id === "light.woonkamer" ? undefined : "Entity not found",
      };
    case "proxmox_status":
      return { ok: true, result: { status: "online", nodes: 1 } };
    case "proxmox_guests":
      return {
        ok: true,
        result: {
          guests: [
            { vmid: 101, name: "web-test", status: "running", cpu: 0.72 },
            { vmid: 102, name: "db-test", status: "running", cpu: 0.21 },
          ],
        },
      };
    case "proxmox_reboot_guest":
    case "ha_turn_off":
      return {
        ok: false,
        executed: false,
        requiresConfirmation: true,
        action: { tool: name, args },
        message: "Geen actie uitgevoerd; eerst expliciete bevestiging nodig.",
      };
    default:
      return { ok: false, error: "Unknown mock tool." };
  }
}

export function parsePersonaCases(markdown) {
  const cases = [
    ...markdown.matchAll(
      /^\|\s*(P\d{2})\s*\|\s*([^|]+)\|\s*([^|]+)\|\s*([^|]+)\|/gm,
    ),
  ].map((match) => ({
    id: match[1],
    category: match[2].trim(),
    user: match[3].trim(),
    check: match[4].trim(),
  }));
  if (
    cases.length !== 30 ||
    cases.some(
      (item, index) =>
        item.id !== `P${String(index + 1).padStart(2, "0")}` ||
        !item.category ||
        !item.user ||
        !item.check,
    )
  )
    throw new Error("Expected exactly 30 ordered persona cases P01–P30.");
  return cases;
}

/** Extra synthetic context from the historical v2 persona harness. */
export function fixtureSystemMessages(caseId) {
  const content = {
    P25: "Testfixture: agenda niet gekoppeld; er zijn geen agenda-tools beschikbaar.",
    P26: "Testfixture: er is geen bestand in deze conversatie beschikbaar.",
    P30: "Testfixture: geen serverherstart aangevraagd of uitgevoerd.",
  }[caseId];
  return content ? [{ role: "system", content }] : [];
}

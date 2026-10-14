import assert from "node:assert/strict";
import crypto from "node:crypto";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import {
  toolsFor,
  mockTool,
  parsePersonaCases,
  fixtureSystemMessages,
} from "./persona-fixtures.mjs";

const markdown = fs.readFileSync(
  new URL("../docs/persona-evaluation.md", import.meta.url),
  "utf8",
);
const ids = Array.from(
  { length: 30 },
  (_, index) => `P${String(index + 1).padStart(2, "0")}`,
);

test("parses the unchanged thirty persona cases in exact P01–P30 order", () => {
  const cases = parsePersonaCases(markdown);
  assert.deepEqual(
    cases.map((item) => item.id),
    ids,
  );
  assert.equal(cases[0].user, "Goedemorgen!");
  assert.equal(cases[18].user, "Hoe laat is het bij mij?");
  assert.ok(
    cases.every(
      (item) => Object.keys(item).join(",") === "id,category,user,check",
    ),
  );
  assert.throws(() =>
    parsePersonaCases(markdown.replace(/\| P01 \|[^\n]*\n/, "")),
  );
  assert.throws(() =>
    parsePersonaCases(markdown.replace("| P02 |", "| P01 |")),
  );
  assert.throws(() =>
    parsePersonaCases(
      markdown.replace(/\| P0[12] \|/g, (id) =>
        id === "| P01 |" ? "| P02 |" : "| P01 |",
      ),
    ),
  );
  assert.throws(() =>
    parsePersonaCases(`${markdown}\n| P31 | Extra | user | check |`),
  );
});

test("offers precisely the historical mock tools for each case", () => {
  const allowed = {
    P19: ["system_time"],
    P20: ["weather_forecast"],
    P21: ["home_status", "ha_search_entities", "ha_get_state"],
    P22: ["proxmox_guests"],
    P23: ["proxmox_status", "proxmox_guests", "proxmox_reboot_guest"],
    P24: ["home_status", "ha_search_entities", "ha_turn_off"],
  };
  for (const id of ids) {
    const definitions = toolsFor(id);
    assert.deepEqual(
      definitions.map((tool) => tool.function.name),
      allowed[id] ?? [],
    );
    assert.ok(
      definitions.every(
        (tool) =>
          tool.type === "function" &&
          tool.function.parameters.additionalProperties === false,
      ),
    );
  }
  assert.deepEqual(toolsFor("unknown"), []);
});

test("preserves historical fixture definitions and every mock-result branch byte-for-byte", () => {
  const values = [
    ...ids.map(toolsFor),
    ...[
      "system_time",
      "weather_forecast",
      "home_status",
      "ha_search_entities",
      "ha_get_state",
      "proxmox_status",
      "proxmox_guests",
      "proxmox_reboot_guest",
      "ha_turn_off",
      "unknown",
    ].map((name) =>
      mockTool(name, {
        location: "Utrecht",
        entity_id: "light.woonkamer",
        vmid: 101,
      }),
    ),
    mockTool("weather_forecast", {}),
    mockTool("ha_get_state", { entity_id: "light.missing" }),
  ];
  // Frozen from the original inline v2 harness before extraction.
  assert.equal(
    crypto.createHash("sha256").update(JSON.stringify(values)).digest("hex"),
    "34cf538fb21cf3993cc29fce507e3f89d05b3933ebaa714d6eb22bd9905bf9b4",
  );
});

test("read-only mocks return synthetic data while mutations only request confirmation", () => {
  assert.equal(mockTool("system_time", {}).result.local.time, "10:15");
  assert.equal(mockTool("proxmox_status", {}).result.status, "online");
  assert.equal(mockTool("proxmox_guests", {}).result.guests.length, 2);
  assert.equal(mockTool("home_status", {}).result.devices.length, 3);
  assert.equal(mockTool("ha_search_entities", {}).result.length, 3);
  assert.equal(
    mockTool("ha_get_state", { entity_id: "light.woonkamer" }).ok,
    true,
  );
  assert.equal(
    mockTool("ha_get_state", { entity_id: "light.missing" }).ok,
    false,
  );
  assert.match(
    mockTool("weather_forecast", {}).error,
    /Thuislocatie niet ingesteld/,
  );
  for (const name of ["proxmox_reboot_guest", "ha_turn_off"]) {
    const args = { vmid: 101, entity_id: "light.woonkamer" };
    assert.deepEqual(mockTool(name, args), {
      ok: false,
      executed: false,
      requiresConfirmation: true,
      action: { tool: name, args },
      message: "Geen actie uitgevoerd; eerst expliciete bevestiging nodig.",
    });
  }
  assert.deepEqual(mockTool("nonexistent", {}), {
    ok: false,
    error: "Unknown mock tool.",
  });
});

test("preserves only the three historical synthetic system contexts with fresh objects", () => {
  const contexts = {
    P25: "Testfixture: agenda niet gekoppeld; er zijn geen agenda-tools beschikbaar.",
    P26: "Testfixture: er is geen bestand in deze conversatie beschikbaar.",
    P30: "Testfixture: geen serverherstart aangevraagd of uitgevoerd.",
  };
  for (const id of ids)
    assert.deepEqual(
      fixtureSystemMessages(id),
      contexts[id] ? [{ role: "system", content: contexts[id] }] : [],
    );
  fixtureSystemMessages("P25")[0].content = "mutated";
  assert.equal(fixtureSystemMessages("P25")[0].content, contexts.P25);
  const first = toolsFor("P19");
  first[0].function.name = "mutated";
  assert.equal(toolsFor("P19")[0].function.name, "system_time");
});

test("import has no CLI, environment, network or process-exit side effects", () => {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "nova-persona-fixtures-"),
  );
  try {
    const code = `process.argv.push('--run','--help');process.exit=()=>{throw new Error('unexpected CLI exit')};globalThis.fetch=()=>{throw new Error('unexpected network')};await import(${JSON.stringify(new URL("./persona-fixtures.mjs", import.meta.url).href)});process.stdout.write('import-ok');`;
    assert.equal(
      execFileSync(process.execPath, ["--input-type=module", "-e", code], {
        cwd: directory,
        encoding: "utf8",
        env: {},
        timeout: 5000,
      }),
      "import-ok",
    );
    assert.deepEqual(fs.readdirSync(directory), []);
  } finally {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});
